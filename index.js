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
                SELECT pp.id_produto, p.id_categoria, SUM(pp.qtd_comp) AS total_produtos
                FROM Pedido_Produto pp
                JOIN Produto p ON p.id_produto = pp.id_produto
                GROUP BY pp.id_produto, p.id_categoria
            ),
            medias AS (
                SELECT id_categoria, AVG(total_produtos) AS media
                FROM total_produto
                GROUP BY id_categoria
            )
            SELECT c.nome AS categoria, p.nome AS produto,
                   SUM(pp.qtd_comp) AS quantidade_total_vendida,
                   ROUND(m.media, 2) AS media_vendas_categoria,
                   ROUND(SUM(pp.qtd_comp) - m.media, 2) AS diferenca
            FROM Produto p
            JOIN Pedido_Produto pp ON p.id_produto = pp.id_produto
            JOIN Categoria c ON c.id_categoria = p.id_categoria
            JOIN medias m ON m.id_categoria = p.id_categoria
            GROUP BY p.id_produto, p.nome, c.id_categoria, c.nome, m.media
            HAVING SUM(pp.qtd_comp) > m.media
            ORDER BY diferenca DESC;
        `;
        res.json((await db.query(sql)).rows);
    } catch (e) { fail(res, e); }
});

app.get("/api/relatorios/q2/:categoria", async (req, res) => {
    try {
        const sql = `
            SELECT c.nome || ' ' || c.sobrenome AS cliente,
                   COUNT(DISTINCT p.id_produto) AS qtd_produtos_distintos,
                   SUM(pp.valor_final) AS total_gasto,
                   MAX(pe.data_pedido) AS ultima_compra
            FROM Cliente c
            JOIN Pedido pe ON pe.id_cliente = c.id_cliente
            JOIN Pedido_Produto pp ON pp.id_pedido = pe.id_pedido
            JOIN Produto p ON p.id_produto = pp.id_produto
            WHERE p.id_categoria = $1
              AND NOT EXISTS (
                  SELECT p2.id_produto
                  FROM Produto p2
                  WHERE p2.id_categoria = $1
                    AND p2.status = 'Disponível'
                  EXCEPT
                  SELECT pp2.id_produto
                  FROM Pedido_Produto pp2
                  JOIN Pedido pe2 ON pe2.id_pedido = pp2.id_pedido
                  WHERE pe2.id_cliente = c.id_cliente
                    AND pp2.id_produto IN (
                        SELECT p3.id_produto
                        FROM Produto p3
                        WHERE p3.id_categoria = $1
                    )
              )
            GROUP BY c.id_cliente, c.nome, c.sobrenome
            ORDER BY total_gasto DESC;
        `;
        res.json((await db.query(sql, [req.params.categoria])).rows);
    } catch (e) { fail(res, e); }
});

app.get("/api/relatorios/q3", async (req, res) => {
    try {
        const sql = `
            SELECT a.id_armazem, a.nome, a.cidade,
                   COUNT(*) AS qtd_under_min,
                   ROUND(AVG(pa.qtd_dis), 2) AS qtd_media_disp,
                   ROUND(AVG(p.preco_venda), 2) AS preco_medio
            FROM Armazem a
            JOIN Produto_Armazem pa ON a.id_armazem = pa.id_armazem
            JOIN Produto p ON p.id_produto = pa.id_produto
            WHERE pa.qtd_atual < pa.qtd_min_dis
              AND p.status = 'Disponível'
              AND p.preco_venda > (SELECT AVG(p2.preco_venda) FROM Produto p2)
            GROUP BY a.id_armazem, a.nome, a.cidade
            ORDER BY qtd_under_min DESC;
        `;
        res.json((await db.query(sql)).rows);
    } catch (e) { fail(res, e); }
});

app.get("/api/relatorios/q4", async (req, res) => {
    try {
        const sql = `
            WITH best_category AS (
                SELECT f.id_funcionario, p.id_categoria,
                       ROW_NUMBER() OVER (
                           PARTITION BY f.id_funcionario
                           ORDER BY SUM(pp.valor_final) DESC
                       ) AS posicao
                FROM Funcionario f
                JOIN Pedido pe ON pe.id_funcionario = f.id_funcionario
                JOIN Pedido_Produto pp ON pp.id_pedido = pe.id_pedido
                JOIN Produto p ON p.id_produto = pp.id_produto
                GROUP BY f.id_funcionario, p.id_categoria
            ),
            sum_sell_func AS (
                SELECT f.id_funcionario,
                       COALESCE(SUM(pp.valor_final), 0) AS total
                FROM Funcionario f
                LEFT JOIN Pedido pe ON pe.id_funcionario = f.id_funcionario
                LEFT JOIN Pedido_Produto pp ON pp.id_pedido = pe.id_pedido
                GROUP BY f.id_funcionario
            )
            SELECT f.nome AS funcionario,
                   ROUND(ss.total, 2) AS total_vendido,
                   c.nome AS categoria_maior_faturamento,
                   CASE WHEN ss.total >= COALESCE(f.meta_mensal, 0) 
                        THEN CONCAT(f.perc_comp, '%')
		                ELSE CONCAT(ROUND(f.perc_comp / 2, 2), '%') END AS percentual_comissao,
                   CASE WHEN ss.total >= COALESCE(f.meta_mensal, 0)
                        THEN ROUND((f.perc_comp / 100) * ss.total, 2)
                        ELSE ROUND((f.perc_comp / 200) * ss.total, 2) END AS comissao,
                   CASE WHEN ss.total >= COALESCE(f.meta_mensal, 0)
                        THEN ROUND(f.salario + ((f.perc_comp / 100) * ss.total), 2)
                        ELSE ROUND(f.salario + ((f.perc_comp / 200) * ss.total), 2) END AS salario_final
            FROM Funcionario f
            JOIN sum_sell_func ss ON ss.id_funcionario = f.id_funcionario
            JOIN best_category bc ON bc.id_funcionario = f.id_funcionario
            JOIN Categoria c ON c.id_categoria = bc.id_categoria
            WHERE bc.posicao = 1
            ORDER BY salario_final DESC;
        `;
        res.json((await db.query(sql)).rows);
    } catch (e) { fail(res, e); }
});

app.get("/api/relatorios/q5", async (req, res) => {
    try {
        const sql = `
            WITH FaturamentoTotal AS (
                SELECT SUM(pag.valor) AS total_geral
                FROM Pagamento pag
                JOIN Pedido ped ON pag.id_pedido = ped.id_pedido
                WHERE pag.status = 'Pago' AND ped.status <> 'Cancelado'
            ),
            MetricasPagamento AS (
                SELECT 
                    pag.tipo AS tipo_pagamento,
                    COUNT(DISTINCT ped.id_pedido) AS qtd_pedidos_pagos,
                    SUM(pp.qtd_comp) AS qtd_total_produtos,
                    SUM(pag.valor) AS valor_total_recebido,
                    AVG(pag.valor) AS ticket_medio
                FROM Pagamento pag
                JOIN Pedido ped ON pag.id_pedido = ped.id_pedido
                JOIN Pedido_Produto pp ON ped.id_pedido = pp.id_pedido
                WHERE pag.status = 'Pago' AND ped.status <> 'Cancelado'
                GROUP BY pag.tipo
            )
            SELECT 
                mp.tipo_pagamento,
                mp.qtd_pedidos_pagos,
                mp.qtd_total_produtos,
                ROUND(mp.valor_total_recebido, 2) AS valor_total_recebido,
                ROUND(mp.ticket_medio, 2) AS ticket_medio,
                ROUND((mp.valor_total_recebido * 100.0) / ft.total_geral, 2) AS percentual_total
            FROM MetricasPagamento mp
            CROSS JOIN FaturamentoTotal ft
            ORDER BY valor_total_recebido DESC;
        `;
        res.json((await db.query(sql)).rows);
    } catch (e) { fail(res, e); }
});

app.get("/api/relatorios/q6", async (req, res) => {
    try {
        const sql = `
            SELECT pe.canal_compra, pg.tipo AS metodo_pagamento,
                   COUNT(pe.id_pedido) AS qtd_pedidos,
                   SUM(pg.valor) AS receita_total,
                   ROUND(AVG(pg.valor), 2) AS ticket_medio
            FROM Pedido pe
            JOIN Pagamento pg ON pe.id_pedido = pg.id_pedido
            WHERE pg.status = 'Pago'
            GROUP BY pe.canal_compra, pg.tipo
            ORDER BY receita_total DESC;
        `;
        res.json((await db.query(sql)).rows);
    } catch (e) { fail(res, e); }
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
