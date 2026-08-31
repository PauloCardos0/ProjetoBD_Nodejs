require("dotenv").config();
const express = require("express");
const path = require("path");
const db = require("./db.js");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function fail(res, err) {
    console.error(err);
    res.status(400).json({ error: err.message });
}

function n(v) {
    return v === "" || v === undefined ? null : v;
}

async function transaction(callback) {
    const client = await db.getClient();
    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
}


// DASHBOARD / CONSULTAS

app.get("/api/relatorios/q1", async (req, res) => {
    try {
        const sql = `
            WITH total_produto AS (
                SELECT pd_pr3.id_produto, pr3.id_categoria, SUM(pd_pr3.qtd_comp)
                AS total_produtos
                FROM Pedido_Produto pd_pr3
                JOIN Produto pr3 ON pr3.id_produto = pd_pr3.id_produto
                GROUP BY pd_pr3.id_produto, pr3.id_categoria
            ),
            medias AS (
                SELECT tp.id_categoria, AVG(tp.total_produtos) AS media
                FROM total_produto tp
                GROUP BY tp.id_categoria
            )
            SELECT ct.nome AS categoria,
                   pr.nome AS produto,
                   SUM(pd_pr.qtd_comp) AS soma,
                   m.media,
                   SUM(pd_pr.qtd_comp) - m.media AS diferenca
            FROM Produto pr
            JOIN Pedido_Produto pd_pr ON pr.id_produto = pd_pr.id_produto
            JOIN Categoria ct ON ct.id_categoria = pr.id_categoria
            JOIN medias m ON m.id_categoria = pr.id_categoria
            GROUP BY pr.id_produto, ct.id_categoria, m.media
            HAVING SUM(pd_pr.qtd_comp) > m.media
            ORDER BY diferenca DESC;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});

app.get("/api/relatorios/q2", async (req, res) => {
    try {
        const sql = `
            SELECT c.nome,
                   COUNT(DISTINCT pr3.id_produto) AS qtd_prod_distc,
                   SUM(pd_pr3.valor_final) AS total_gasto,
                   MAX(data_pedido) AS ultima_compra
            FROM Cliente c
            JOIN Pedido pd3 ON c.id_Cliente = pd3.id_cliente
            JOIN Pedido_Produto pd_pr3 ON pd_pr3.id_pedido = pd3.id_pedido
            JOIN Produto pr3 ON pr3.id_produto = pd_pr3.id_produto
            WHERE pr3.id_categoria = 1 AND
            NOT EXISTS(
                SELECT pd_pr2.id_produto FROM Pedido_Produto pd_pr2
                JOIN Produto pd2 ON pd_pr2.id_produto = pd2.id_produto
                WHERE pd2.id_categoria = 1
                EXCEPT
                SELECT pd_pr.id_produto FROM Pedido_Produto pd_pr
                JOIN Pedido pr ON pd_pr.id_pedido = pr.id_pedido
                JOIN Produto pd ON pd_pr.id_produto = pd.id_produto
                WHERE c.id_cliente = pr.id_cliente AND pd.id_categoria = 1
            )
            GROUP BY c.id_cliente;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});

app.get("/api/relatorios/q3", async (req, res) => {
    try {
        const sql = `
            SELECT ar.id_armazem, ar.nome, ar.cidade, COUNT(*) qtd_under_min,
                   AVG(pd_am.qtd_dis) AS qtd_media_disp,
                   AVG(pr.preco_venda) AS preco_medio
            FROM Armazem ar
            JOIN Produto_Armazem pd_am ON ar.id_armazem = pd_am.id_armazem
            JOIN Produto pr ON pr.id_produto = pd_am.id_produto
            WHERE qtd_atual < qtd_min_dis AND pr.status = 'Disponível' AND
                  pr.preco_venda > (
                      SELECT AVG(pr2.preco_venda) FROM Produto pr2
                  )
            GROUP BY ar.id_armazem
            ORDER BY qtd_under_min DESC;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});

app.get("/api/relatorios/q4", async (req, res) => {
    try {
        const sql = `
            WITH best_category AS (
                SELECT fr.id_funcionario,
                       pr.id_categoria,
                       ROW_NUMBER() OVER (
                           PARTITION BY fr.id_funcionario
                           ORDER BY SUM(pd_pr.valor_final) DESC) AS posicao
                FROM Funcionario fr
                JOIN Pedido pd ON pd.id_funcionario = fr.id_funcionario
                JOIN Pedido_Produto pd_pr ON pd_pr.id_pedido = pd.id_pedido
                JOIN Produto pr ON pr.id_produto = pd_pr.id_produto
                GROUP BY fr.id_funcionario, pr.id_categoria
            ),

            sum_sell_func AS (
                SELECT
                    fr.id_funcionario,
                    COALESCE(SUM(pd_pr.valor_final), 0) AS total
                FROM Funcionario fr
                LEFT JOIN Pedido pd ON pd.id_funcionario = fr.id_funcionario
                LEFT JOIN Pedido_Produto pd_pr ON pd_pr.id_pedido = pd.id_pedido
                GROUP BY fr.id_funcionario
            )

            SELECT fr.nome AS funcionario,
                   ss.total,
                   ct.nome AS categoria,

                   CASE
                       WHEN ss.total >= COALESCE(fr.meta_mensal, 0) THEN
                           CONCAT(fr.perc_comp, '%')
                       ELSE
                           CONCAT(ROUND(fr.perc_comp / 2, 2), '%')
                   END AS percentual_comissao,

                   CASE
                       WHEN ss.total >= COALESCE(fr.meta_mensal, 0) THEN
                           ROUND((fr.perc_comp / 100) * ss.total, 2)
                       ELSE
                           ROUND((fr.perc_comp / 200 ) * ss.total, 2)
                   END AS comissao,

                   CASE
                       WHEN ss.total >= COALESCE(fr.meta_mensal, 0) THEN
                           ROUND(((fr.perc_comp / 100) * ss.total) + fr.salario, 2)
                       ELSE
                           ROUND(((fr.perc_comp / 200 ) * ss.total) + fr.salario, 2)
                   END AS salario_final

            FROM Funcionario fr
            JOIN sum_sell_func ss
                ON fr.id_funcionario = ss.id_funcionario
            JOIN best_category bc
                ON fr.id_funcionario = bc.id_funcionario
            JOIN categoria ct
                ON bc.id_categoria = ct.id_categoria
            WHERE bc.posicao = 1
            ORDER BY salario_final DESC;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});

app.get("/api/relatorios/q5", async (req, res) => {
    try {
        const sql = `
            WITH total_geral AS (
                SELECT SUM(pd_pr2.valor_final) AS total
                FROM Pedido_Produto pd_pr2
                JOIN Pedido pd2 ON pd2.id_pedido = pd_pr2.id_pedido
                WHERE pd2.status <> 'Cancelado'
            )

            SELECT pg.tipo,
                   COUNT(DISTINCT pd.id_pedido) AS qtd_pedidos,
                   COUNT(pd_pr.id_produto) AS qtd_produtos,
                   SUM(pd_pr.valor_final) AS valor_total,
                   ROUND(
                       SUM(pd_pr.valor_final) /
                       COUNT(DISTINCT pd.id_pedido),
                       2
                   ) AS ticket_medio,
                   CONCAT(
                       ROUND(
                           SUM(pd_pr.valor_final) / tg.total * 100,
                           2
                       ),
                       '%'
                   ) AS percent_total

            FROM Pagamento pg
            JOIN Pedido pd
                ON pg.id_pedido = pd.id_pedido
            JOIN Pedido_Produto pd_pr
                ON pd.id_pedido = pd_pr.id_pedido
            CROSS JOIN total_geral tg

            WHERE pg.status = 'Pago'
              AND pd.status <> 'Cancelado'

            GROUP BY pg.tipo, tg.total

            ORDER BY valor_total DESC;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});

app.get("/api/relatorios/q6", async (req, res) => {
    try {
        const sql = `
            WITH vendas_fornecedor AS (
                SELECT fr.id_fornecedor,
                       SUM(pd_pr.valor_final) AS total_vendas
                FROM Fornecedor fr
                JOIN Produto pr ON pr.id_fornecedor = fr.id_fornecedor
                JOIN Pedido_Produto pd_pr ON pd_pr.id_produto = pr.id_produto
                JOIN Pedido pd ON pd_pr.id_pedido = pd.id_pedido
                WHERE pd.status <> 'Cancelado'
                GROUP BY fr.id_fornecedor
            ),

            media_vendas AS (
                SELECT AVG(total_vendas) AS media
                FROM vendas_fornecedor
            )

            SELECT fr.nome,
                   COUNT(DISTINCT pr.id_produto) AS qtd_prod_dist,
                   SUM(pd_pr.qtd_comp) AS qtd_vendida,
                   SUM(pd_pr.valor_final) AS total_vendas,
                   ROUND(AVG(pr.preco_venda), 2) AS avg_preco_prod

            FROM Fornecedor fr
            JOIN Produto pr
                ON pr.id_fornecedor = fr.id_fornecedor
            JOIN Pedido_Produto pd_pr
                ON pd_pr.id_produto = pr.id_produto
            JOIN Pedido pd
                ON pd_pr.id_pedido = pd.id_pedido
            CROSS JOIN media_vendas mv

            WHERE pd.status <> 'Cancelado'

            GROUP BY fr.id_fornecedor, fr.nome, mv.media

            HAVING SUM(pd_pr.valor_final) > mv.media

            ORDER BY total_vendas DESC;
        `;

        const result = await db.query(sql);
        res.json(result.rows);

    } catch (e) {
        fail(res, e);
    }
});


// CATEGORIA

app.get("/api/categorias", async (req,res) => {
    try { res.json((await db.query("SELECT * FROM Categoria ORDER BY id_categoria")).rows); }
    catch(e){ fail(res,e); }
});
app.post("/api/categorias", async(req,res)=>{
    try {
        const {nome, descricao, departamento}=req.body;
        res.json((await db.query(
            "INSERT INTO Categoria(nome,descricao,departamento) VALUES($1,$2,$3) RETURNING *",
            [nome, n(descricao), n(departamento)]
        )).rows[0]);
    } catch(e){ fail(res,e); }
});
app.put("/api/categorias/:id", async(req,res)=>{
    try {
        const {nome,descricao,departamento}=req.body;
        res.json((await db.query(
            "UPDATE Categoria SET nome=$1,descricao=$2,departamento=$3 WHERE id_categoria=$4 RETURNING *",
            [nome,n(descricao),n(departamento),req.params.id]
        )).rows[0]);
    } catch(e){ fail(res,e); }
});
app.delete("/api/categorias/:id", async(req,res)=>{
    try { await db.query("DELETE FROM Categoria WHERE id_categoria=$1",[req.params.id]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});


// FORNECEDOR

app.get("/api/fornecedores", async(req,res)=>{
    try { res.json((await db.query("SELECT * FROM Fornecedor ORDER BY id_fornecedor")).rows); }
    catch(e){ fail(res,e); }
});
app.post("/api/fornecedores", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`INSERT INTO Fornecedor
            (nome,nome_fantasia,cpf_cnpj,data_cadastro,rua,numero,bairro,complemento,cidade,estado,pais,cep)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`;
        res.json((await db.query(sql,[b.nome,n(b.nome_fantasia),b.cpf_cnpj,b.data_cadastro,b.rua,b.numero,b.bairro,n(b.complemento),b.cidade,b.estado,b.pais,b.cep])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.put("/api/fornecedores/:id", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`UPDATE Fornecedor SET nome=$1,nome_fantasia=$2,cpf_cnpj=$3,data_cadastro=$4,rua=$5,numero=$6,bairro=$7,complemento=$8,cidade=$9,estado=$10,pais=$11,cep=$12 WHERE id_fornecedor=$13 RETURNING *`;
        res.json((await db.query(sql,[b.nome,n(b.nome_fantasia),b.cpf_cnpj,b.data_cadastro,b.rua,b.numero,b.bairro,n(b.complemento),b.cidade,b.estado,b.pais,b.cep,req.params.id])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.delete("/api/fornecedores/:id", async(req,res)=>{
    try { await db.query("DELETE FROM Fornecedor WHERE id_fornecedor=$1",[req.params.id]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});


// PRODUTO

app.get("/api/produtos", async(req,res)=>{
    try {
        const sql=`SELECT p.*, c.nome AS categoria_nome, f.nome AS fornecedor_nome
                   FROM Produto p
                   LEFT JOIN Categoria c ON c.id_categoria=p.id_categoria
                   LEFT JOIN Fornecedor f ON f.id_fornecedor=p.id_fornecedor
                   ORDER BY p.id_produto`;
        res.json((await db.query(sql)).rows);
    } catch(e){ fail(res,e); }
});
app.post("/api/produtos", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`INSERT INTO Produto(nome,descricao,marca,peso,data_fab,prazo_garantia,preco_venda,preco_min,status,id_categoria,id_fornecedor)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`;
        res.json((await db.query(sql,[b.nome,n(b.descricao),n(b.marca),n(b.peso),b.data_fab,n(b.prazo_garantia),b.preco_venda,b.preco_min,b.status||"Disponível",n(b.id_categoria),n(b.id_fornecedor)])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.put("/api/produtos/:id", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`UPDATE Produto SET nome=$1,descricao=$2,marca=$3,peso=$4,data_fab=$5,prazo_garantia=$6,preco_venda=$7,preco_min=$8,status=$9,id_categoria=$10,id_fornecedor=$11
                   WHERE id_produto=$12 RETURNING *`;
        res.json((await db.query(sql,[b.nome,n(b.descricao),n(b.marca),n(b.peso),b.data_fab,n(b.prazo_garantia),b.preco_venda,b.preco_min,b.status,n(b.id_categoria),n(b.id_fornecedor),req.params.id])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.delete("/api/produtos/:id", async(req,res)=>{
    try { await db.query("DELETE FROM Produto WHERE id_produto=$1",[req.params.id]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});


// ARMAZÉM

app.get("/api/armazens", async(req,res)=>{
    try { res.json((await db.query("SELECT * FROM Armazem ORDER BY id_armazem")).rows); }
    catch(e){ fail(res,e); }
});
app.post("/api/armazens", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`INSERT INTO Armazem(nome,capacidade_max,data_abbertura,rua,numero,bairro,cidade,estado,cep)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`;
        res.json((await db.query(sql,[b.nome,b.capacidade_max,b.data_abbertura,b.rua,b.numero,b.bairro,b.cidade,b.estado,b.cep])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.put("/api/armazens/:id", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`UPDATE Armazem SET nome=$1,capacidade_max=$2,data_abbertura=$3,rua=$4,numero=$5,bairro=$6,cidade=$7,estado=$8,cep=$9
                   WHERE id_armazem=$10 RETURNING *`;
        res.json((await db.query(sql,[b.nome,b.capacidade_max,b.data_abbertura,b.rua,b.numero,b.bairro,b.cidade,b.estado,b.cep,req.params.id])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.delete("/api/armazens/:id", async(req,res)=>{
    try { await db.query("DELETE FROM Armazem WHERE id_armazem=$1",[req.params.id]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});

// Estoque Produto_Armazem
app.get("/api/estoques", async(req,res)=>{
    try {
        const sql=`SELECT pa.*, p.nome AS produto_nome, a.nome AS armazem_nome
                   FROM Produto_Armazem pa
                   JOIN Produto p ON p.id_produto=pa.id_produto
                   JOIN Armazem a ON a.id_armazem=pa.id_armazem
                   ORDER BY a.id_armazem,p.id_produto`;
        res.json((await db.query(sql)).rows);
    } catch(e){ fail(res,e); }
});
app.post("/api/estoques", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`INSERT INTO Produto_Armazem(qtd_min_dis,qtd_atual,qtd_dis,loc_fisica,id_produto,id_armazem)
                   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`;
        res.json((await db.query(sql,[b.qtd_min_dis,b.qtd_atual,b.qtd_dis,b.loc_fisica,b.id_produto,b.id_armazem])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.put("/api/estoques/:produto/:armazem", async(req,res)=>{
    try {
        const b=req.body;
        const sql=`UPDATE Produto_Armazem SET qtd_min_dis=$1,qtd_atual=$2,qtd_dis=$3,loc_fisica=$4
                   WHERE id_produto=$5 AND id_armazem=$6 RETURNING *`;
        res.json((await db.query(sql,[b.qtd_min_dis,b.qtd_atual,b.qtd_dis,b.loc_fisica,req.params.produto,req.params.armazem])).rows[0]);
    } catch(e){ fail(res,e); }
});
app.delete("/api/estoques/:produto/:armazem", async(req,res)=>{
    try { await db.query("DELETE FROM Produto_Armazem WHERE id_produto=$1 AND id_armazem=$2",[req.params.produto,req.params.armazem]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});


// CLIENTE

app.get("/api/clientes", async(req,res)=>{
    try {
        const sql=`SELECT c.*,
                          e.email,
                          pf.cpf,pf.rg,pf.estado_civil,
                          pj.cnpj,pj.razao_social,pj.nome_fantasia AS pj_nome_fantasia,pj.insc_estadual
                   FROM Cliente c
                   LEFT JOIN LATERAL (SELECT email FROM Email_Cliente e WHERE e.id_cliente=c.id_cliente ORDER BY email LIMIT 1) e ON true
                   LEFT JOIN LATERAL (SELECT cpf,rg,estado_civil FROM Cliente_Pf pf WHERE pf.id_cliente=c.id_cliente LIMIT 1) pf ON true
                   LEFT JOIN LATERAL (SELECT cnpj,razao_social,nome_fantasia,insc_estadual FROM Cliente_Pj pj WHERE pj.id_cliente=c.id_cliente LIMIT 1) pj ON true
                   ORDER BY c.id_cliente`;
        res.json((await db.query(sql)).rows);
    } catch(e){ fail(res,e); }
});

async function salvarCliente(req,res,update=false) {
    try {
        const b=req.body;
        const result=await transaction(async(client)=>{
            let id;
            if(!update){
                const r=await client.query(
                    `INSERT INTO Cliente(nome,sobrenome,nome_social,rua,numero,bairro,complemento,cidade,estado,pais,cep,data_cadastro,data_nasc,lim_credito,profissao,renda_aprox)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id_cliente`,
                    [b.nome,b.sobrenome,n(b.nome_social),b.rua,b.numero,b.bairro,n(b.complemento),b.cidade,b.estado,b.pais,b.cep,b.data_cadastro,b.data_nasc||null,b.lim_credito||null,n(b.profissao),b.renda_aprox||null]
                );
                id=r.rows[0].id_cliente;
            } else {
                id=req.params.id;
                await client.query(
                    `UPDATE Cliente SET nome=$1,sobrenome=$2,nome_social=$3,rua=$4,numero=$5,bairro=$6,complemento=$7,cidade=$8,estado=$9,pais=$10,cep=$11,data_cadastro=$12,data_nasc=$13,lim_credito=$14,profissao=$15,renda_aprox=$16 WHERE id_cliente=$17`,
                    [b.nome,b.sobrenome,n(b.nome_social),b.rua,b.numero,b.bairro,n(b.complemento),b.cidade,b.estado,b.pais,b.cep,b.data_cadastro,b.data_nasc||null,b.lim_credito||null,n(b.profissao),b.renda_aprox||null,id]
                );
                await client.query("DELETE FROM Cliente_Pf WHERE id_cliente=$1",[id]);
                await client.query("DELETE FROM Cliente_Pj WHERE id_cliente=$1",[id]);
                await client.query("DELETE FROM Email_Cliente WHERE id_cliente=$1",[id]);
            }
            if(b.email) await client.query("INSERT INTO Email_Cliente(id_cliente,email) VALUES($1,$2)",[id,b.email]);
            if(b.tipo_pessoa==="PJ"){
                await client.query(`INSERT INTO Cliente_Pj(cnpj,razao_social,nome_fantasia,insc_estadual,id_cliente) VALUES($1,$2,$3,$4,$5)`,
                    [b.cnpj,b.razao_social,n(b.pj_nome_fantasia),b.insc_estadual,id]);
            } else {
                await client.query(`INSERT INTO Cliente_Pf(cpf,rg,estado_civil,id_cliente) VALUES($1,$2,$3,$4)`,
                    [b.cpf,b.rg,b.estado_civil,id]);
            }
            return id;
        });
        res.json({ok:true,id_cliente:result});
    } catch(e){ fail(res,e); }
}
app.post("/api/clientes",(req,res)=>salvarCliente(req,res,false));
app.put("/api/clientes/:id",(req,res)=>salvarCliente(req,res,true));
app.delete("/api/clientes/:id", async(req,res)=>{
    try {
        await transaction(async(client)=>{
            await client.query("DELETE FROM Email_Cliente WHERE id_cliente=$1",[req.params.id]);
            await client.query("DELETE FROM Telefone_Cliente WHERE id_cliente=$1",[req.params.id]);
            await client.query("DELETE FROM Cliente_Pf WHERE id_cliente=$1",[req.params.id]);
            await client.query("DELETE FROM Cliente_Pj WHERE id_cliente=$1",[req.params.id]);
            await client.query("DELETE FROM Cliente WHERE id_cliente=$1",[req.params.id]);
        });
        res.json({ok:true});
    } catch(e){ fail(res,e); }
});

// Telefones de cliente
app.post("/api/clientes/:id/telefone", async(req,res)=>{
    try { res.json((await db.query("INSERT INTO Telefone_Cliente(id_cliente,telefone) VALUES($1,$2) RETURNING *",[req.params.id,req.body.telefone])).rows[0]); }
    catch(e){ fail(res,e); }
});
app.delete("/api/clientes/:id/telefone/:telefone", async(req,res)=>{
    try { await db.query("DELETE FROM Telefone_Cliente WHERE id_cliente=$1 AND telefone=$2",[req.params.id,req.params.telefone]); res.json({ok:true}); }
    catch(e){ fail(res,e); }
});


// FUNCIONÁRIO

app.get("/api/funcionarios", async(req,res)=>{
    try {
        const sql=`SELECT f.*, e.email,
                   tf.telefone
                   FROM Funcionario f
                   LEFT JOIN LATERAL (SELECT email FROM Email_Funcionario WHERE id_funcionario=f.id_funcionario ORDER BY email LIMIT 1) e ON true
                   LEFT JOIN LATERAL (SELECT telefone FROM Telefone_Funcionario WHERE id_funcionario=f.id_funcionario ORDER BY telefone LIMIT 1) tf ON true
                   ORDER BY f.id_funcionario`;
        res.json((await db.query(sql)).rows);
    } catch(e){ fail(res,e); }
});
async function salvarFuncionario(req,res,update=false){
    try{
        const b=req.body;
        const result=await transaction(async(client)=>{
            let id;
            const vals=[b.nome,b.cpf,b.data_nasc,b.data_adm,b.salario,b.cargo,b.rua,b.numero,b.bairro,n(b.complemento),b.cidade,b.estado,b.cep,b.perc_comp||0,b.meta_mensal||null,b.data_ini_func,b.val_bonus_gest||0];
            if(!update){
                const r=await client.query(`INSERT INTO Funcionario(nome,cpf,data_nasc,data_adm,salario,cargo,rua,numero,bairro,complemento,cidade,estado,cep,perc_comp,meta_mensal,data_ini_func,val_bonus_gest)
                                             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id_funcionario`,vals);
                id=r.rows[0].id_funcionario;
            } else {
                id=req.params.id;
                await client.query(`UPDATE Funcionario SET nome=$1,cpf=$2,data_nasc=$3,data_adm=$4,salario=$5,cargo=$6,rua=$7,numero=$8,bairro=$9,complemento=$10,cidade=$11,estado=$12,cep=$13,perc_comp=$14,meta_mensal=$15,data_ini_func=$16,val_bonus_gest=$17 WHERE id_funcionario=$18`,[...vals,id]);
                await client.query("DELETE FROM Email_Funcionario WHERE id_funcionario=$1",[id]);
            }
            if(b.email) await client.query("INSERT INTO Email_Funcionario(id_funcionario,email) VALUES($1,$2)",[id,b.email]);
            if(b.telefone) await client.query("INSERT INTO Telefone_Funcionario(id_funcionario,telefone) VALUES($1,$2)",[id,b.telefone]);
            return id;
        });
        res.json({ok:true,id_funcionario:result});
    }catch(e){ fail(res,e); }
}
app.post("/api/funcionarios",(req,res)=>salvarFuncionario(req,res,false));
app.put("/api/funcionarios/:id",(req,res)=>salvarFuncionario(req,res,true));
app.delete("/api/funcionarios/:id",async(req,res)=>{
    try{
        await transaction(async(client)=>{
            await client.query("DELETE FROM Email_Funcionario WHERE id_funcionario=$1",[req.params.id]);
            await client.query("DELETE FROM Telefone_Funcionario WHERE id_funcionario=$1",[req.params.id]);
            await client.query("DELETE FROM Funcionario WHERE id_funcionario=$1",[req.params.id]);
        });
        res.json({ok:true});
    }catch(e){fail(res,e);}
});

// PEDIDOS + ITENS

app.get("/api/pedidos", async(req,res)=>{
    try{
        const sql=`SELECT pe.*, c.nome || ' ' || c.sobrenome AS cliente_nome,
                          f.nome AS funcionario_nome,
                          COALESCE(SUM(pp.valor_final),0) AS total
                   FROM Pedido pe
                   LEFT JOIN Cliente c ON c.id_cliente=pe.id_cliente
                   LEFT JOIN Funcionario f ON f.id_funcionario=pe.id_funcionario
                   LEFT JOIN Pedido_Produto pp ON pp.id_pedido=pe.id_pedido
                   GROUP BY pe.id_pedido,c.nome,c.sobrenome,f.nome
                   ORDER BY pe.id_pedido DESC`;
        res.json((await db.query(sql)).rows);
    }catch(e){fail(res,e);}
});
app.get("/api/pedidos/:id",async(req,res)=>{
    try{
        const pedido=(await db.query(`SELECT pe.*,c.nome||' '||c.sobrenome AS cliente_nome,f.nome AS funcionario_nome
                                      FROM Pedido pe LEFT JOIN Cliente c ON c.id_cliente=pe.id_cliente
                                      LEFT JOIN Funcionario f ON f.id_funcionario=pe.id_funcionario
                                      WHERE pe.id_pedido=$1`,[req.params.id])).rows[0];
        const itens=(await db.query(`SELECT pp.*,p.nome AS produto_nome
                                     FROM Pedido_Produto pp JOIN Produto p ON p.id_produto=pp.id_produto
                                     WHERE pp.id_pedido=$1 ORDER BY p.nome`,[req.params.id])).rows;
        res.json({pedido,itens});
    }catch(e){fail(res,e);}
});
app.post("/api/pedidos",async(req,res)=>{
    try{
        const b=req.body;
        const id=await transaction(async(client)=>{
            const r=await client.query(`INSERT INTO Pedido(data_pedido,canal_compra,status,prazo_entrega,obs,id_funcionario,id_cliente)
                                        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id_pedido`,
                [b.data_pedido,b.canal_compra||"Online",b.status||"Pendente",b.prazo_entrega,n(b.obs),n(b.id_funcionario),n(b.id_cliente)]);
            const pedidoId=r.rows[0].id_pedido;
            for(const item of (b.itens||[])){
                const qtd=Number(item.qtd_comp);
                const preco=Number(item.preco_unit);
                const desconto=Number(item.desconto||0);
                const valor=qtd*preco*(1-desconto/100);
                if(qtd<=0 || preco<=0 || desconto<0 || valor<=0) throw new Error("Item de pedido inválido.");
                await client.query(`INSERT INTO Pedido_Produto(qtd_comp,preco_unit,desconto,valor_final,id_pedido,id_produto)
                                    VALUES($1,$2,$3,$4,$5,$6)`,
                    [qtd,preco,desconto,valor,pedidoId,item.id_produto]);
            }
            return pedidoId;
        });
        res.json({ok:true,id_pedido:id});
    }catch(e){fail(res,e);}
});
app.put("/api/pedidos/:id",async(req,res)=>{
    try{
        const b=req.body;
        await transaction(async(client)=>{
            await client.query(`UPDATE Pedido SET data_pedido=$1,canal_compra=$2,status=$3,prazo_entrega=$4,obs=$5,id_funcionario=$6,id_cliente=$7 WHERE id_pedido=$8`,
                [b.data_pedido,b.canal_compra,b.status,b.prazo_entrega,n(b.obs),n(b.id_funcionario),n(b.id_cliente),req.params.id]);
            await client.query("DELETE FROM Pedido_Produto WHERE id_pedido=$1",[req.params.id]);
            for(const item of (b.itens||[])){
                const qtd=Number(item.qtd_comp), preco=Number(item.preco_unit), desconto=Number(item.desconto||0);
                const valor=qtd*preco*(1-desconto/100);
                await client.query(`INSERT INTO Pedido_Produto(qtd_comp,preco_unit,desconto,valor_final,id_pedido,id_produto)
                                    VALUES($1,$2,$3,$4,$5,$6)`,
                    [qtd,preco,desconto,valor,req.params.id,item.id_produto]);
            }
        });
        res.json({ok:true});
    }catch(e){fail(res,e);}
});
app.delete("/api/pedidos/:id",async(req,res)=>{
    try{
        await transaction(async(client)=>{
            await client.query("DELETE FROM Pagamento WHERE id_pedido=$1",[req.params.id]);
            await client.query("DELETE FROM Pedido_Produto WHERE id_pedido=$1",[req.params.id]);
            await client.query("DELETE FROM Pedido WHERE id_pedido=$1",[req.params.id]);
        });
        res.json({ok:true});
    }catch(e){fail(res,e);}
});

// Itens de pedido
app.post("/api/pedidos/:id/itens",async(req,res)=>{
    try{
        const b=req.body,q=Number(b.qtd_comp),p=Number(b.preco_unit),d=Number(b.desconto||0),v=q*p*(1-d/100);
        res.json((await db.query(`INSERT INTO Pedido_Produto(qtd_comp,preco_unit,desconto,valor_final,id_pedido,id_produto)
                                  VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
            [q,p,d,v,req.params.id,b.id_produto])).rows[0]);
    }catch(e){fail(res,e);}
});
app.delete("/api/pedidos/:pedido/itens/:produto",async(req,res)=>{
    try{await db.query("DELETE FROM Pedido_Produto WHERE id_pedido=$1 AND id_produto=$2",[req.params.pedido,req.params.produto]);res.json({ok:true});}
    catch(e){fail(res,e);}
});


// PAGAMENTOS

app.get("/api/pagamentos",async(req,res)=>{
    try{
        const sql=`SELECT pg.*,pg.id_pedido,c.nome||' '||c.sobrenome AS cliente_nome
                   FROM Pagamento pg
                   LEFT JOIN Pedido pe ON pe.id_pedido=pg.id_pedido
                   LEFT JOIN Cliente c ON c.id_cliente=pe.id_cliente
                   ORDER BY pg.id_pagamento DESC`;
        res.json((await db.query(sql)).rows);
    }catch(e){fail(res,e);}
});
app.post("/api/pagamentos",async(req,res)=>{
    try{
        const b=req.body;
        res.json((await db.query(`INSERT INTO Pagamento(valor,data_pag,tipo,status,id_pedido)
                                  VALUES($1,$2,$3,$4,$5) RETURNING *`,
            [b.valor,b.data_pag,b.tipo,b.status||"Pendente",b.id_pedido])).rows[0]);
    }catch(e){fail(res,e);}
});
app.put("/api/pagamentos/:id",async(req,res)=>{
    try{
        const b=req.body;
        res.json((await db.query(`UPDATE Pagamento SET valor=$1,data_pag=$2,tipo=$3,status=$4,id_pedido=$5
                                  WHERE id_pagamento=$6 RETURNING *`,
            [b.valor,b.data_pag,b.tipo,b.status,b.id_pedido,req.params.id])).rows[0]);
    }catch(e){fail(res,e);}
});
app.delete("/api/pagamentos/:id",async(req,res)=>{
    try{await db.query("DELETE FROM Pagamento WHERE id_pagamento=$1",[req.params.id]);res.json({ok:true});}
    catch(e){fail(res,e);}
});


// API PARA SELECTS

app.get("/api/selects", async(req,res)=>{
    try{
        const [cats,prods,forns,clientes,funcs,pedidos,armazens]=await Promise.all([
            db.query("SELECT id_categoria,nome FROM Categoria ORDER BY nome"),
            db.query("SELECT id_produto,nome,preco_venda FROM Produto ORDER BY nome"),
            db.query("SELECT id_fornecedor,nome FROM Fornecedor ORDER BY nome"),
            db.query("SELECT id_cliente,nome,sobrenome FROM Cliente ORDER BY nome,sobrenome"),
            db.query("SELECT id_funcionario,nome FROM Funcionario ORDER BY nome"),
            db.query("SELECT id_pedido FROM Pedido ORDER BY id_pedido DESC"),
            db.query("SELECT id_armazem,nome FROM Armazem ORDER BY nome")
        ]);
        res.json({
            categorias:cats.rows, produtos:prods.rows, fornecedores:forns.rows,
            clientes:clientes.rows, funcionarios:funcs.rows, pedidos:pedidos.rows, armazens:armazens.rows
        });
    }catch(e){fail(res,e);}
});


app.use((req,res)=>{
    if(req.method==="GET" && !req.path.startsWith("/api/")){
        res.sendFile(path.join(__dirname,"public","index.html"));
    } else {
        res.status(404).json({error:"Rota não encontrada"});
    }
});

app.listen(port,()=>console.log(`Backend rodando na porta ${port}`));
