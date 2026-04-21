const axios = require('axios');
const pLimit = require('p-limit');
const { getAapPool, sql } = require('../db/aap_config.js');

// CONFIGURACIÓN desde .env
const LOTE = parseInt(process.env.AAP_LOTE) || 1000;
const CONCURRENCIA = parseInt(process.env.AAP_CONCURRENCIA) || 5;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_GROUP_ID = process.env.AAP_REGULA_GROUP_ID;

// =====================================
// UTILIDADES
// =====================================

/**
 * Convierte un Buffer a una cadena Base64.
 * @param {Buffer} buffer 
 * @returns {string}
 */
function bufferToBase64(buffer) {
    if (!buffer) return "";
    return buffer.toString('base64');
}

/**
 * Procesa el enrolamiento en la API de Regula.
 * @param {string} base64 
 * @param {object} row 
 */
async function procesarImagen(base64, row) {
    if (!base64) throw new Error("Buffer de imagen vacío, omitiendo enrolamiento.");

    if (!REGULA_URL || !REGULA_GROUP_ID) {
        throw new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
    }

    // Formato de nombre: id_foto_interno_numint_id_centro
    const filename = `${row.id_foto_interno}_${row.numint}_${row.id_centro}`;

    const payload = {
        image_base64: base64,
        filename: filename,
        group_ids: [REGULA_GROUP_ID],
        metadata: {
            numint: row.numint,
            id_centro: row.id_centro
        }
    };

    try {
        const resp = await axios.post(REGULA_URL, payload, {
            timeout: 30000
        });
        return { success: true, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        throw new Error(`Error en REGULA FACE API: ${errorMsg}`);
    }
}

// =====================================
// PROCESAMIENTO
// =====================================

/**
 * Procesa un lote de registros y actualiza su estado en la base de datos.
 */
async function procesarLote(rows, pool) {
    const limit = pLimit(CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        rows.map(row =>
            limit(async () => {
                let regulaTime = 0;
                try {
                    const regulaStart = Date.now();
                    const base64 = bufferToBase64(row.foto);
                    const resp = await procesarImagen(base64, row);
                    regulaTime = Date.now() - regulaStart;

                    return {
                        id_foto_interno: row.id_foto_interno,
                        ok: resp.success === true,
                        regulaTime
                    };

                } catch (err) {
                    console.error(`ID_FOTO_INTERNO: ${row.id_foto_interno} -> `, err.message);
                    return { id_foto_interno: row.id_foto_interno, ok: false, regulaTime: 0 };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    // Actualización de estados masiva
    const exitosos = resultados.filter(r => r.ok).map(r => r.id_foto_interno);
    const fallidos = resultados.filter(r => !r.ok).map(r => r.id_foto_interno);

    const updateStart = Date.now();

    if (exitosos.length > 0) {
        await pool.request()
            .query(`UPDATE Fotos_Internos SET procesada = 1 WHERE id_foto_interno IN (${exitosos.join(',')})`);
    }

    if (fallidos.length > 0) {
        await pool.request()
            .query(`UPDATE Fotos_Internos SET procesada = 4 WHERE id_foto_interno IN (${fallidos.join(',')})`);
    }

    const updateTime = Date.now() - updateStart;
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (rows.length || 1);

    console.log(`   ⏱ Lote ${rows.length}: Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s | DB Update: ${(updateTime / 1000).toFixed(1)}s`);

    return resultados;
}

/**
 * Función principal del worker para SQL Server.
 */
async function taskAapCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento AAP (SQL Server) [${new Date().toLocaleString()}] ---`);

    let pool;
    try {
        pool = await getAapPool();

        while (true) {
            const fetchStart = Date.now();

            const result = await pool.request()
                .input('limit', sql.Int, LOTE)
                .query(`
                    SELECT TOP (@limit) 
                        id_foto_interno, id_centro, id_foto, numint, foto, fecha, procesada
                    FROM Fotos_Internos 
                    WHERE procesada = 0 
                    ORDER BY id_foto_interno ASC
                `);

            const rows = result.recordset;
            const fetchTime = Date.now() - fetchStart;

            if (!rows || rows.length === 0) {
                console.log(`✅ No hay más registros pendientes de procesar.`);
                break;
            }

            console.log(`📦 Lote de ${rows.length} registros recuperado (SQL Fetch: ${fetchTime}ms)`);

            await procesarLote(rows, pool);
        }

        console.log("🎉 Proceso AAP completo");

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento AAP:", err);
    }
}

taskAapCheck();

module.exports = { taskAapCheck };
