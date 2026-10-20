const axios = require('axios');
const pLimit = require('p-limit');
const { getAapPool, sql } = require('../db/aap_config.js');
const { crearControlCarga, esErrorTransitorio, esperar } = require('../utils/controlCarga.js');

// CONFIGURACIÓN desde .env
// SQL Server admite máximo 2100 parámetros, el UPDATE por lote (WHERE id IN) se limita a 1000
const LOTE = Math.min(parseInt(process.env.AAP_LOTE) || 1000, 1000);
const CONCURRENCIA = parseInt(process.env.AAP_CONCURRENCIA) || 5;
const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const REGULA_GROUP_ID = process.env.AAP_REGULA_GROUP_ID;
const BIOMETRIC_API_SECRET = process.env.BIOMETRIC_API_SECRET || '';

// Control de carga (0 = deshabilitado)
const MAX_REGISTROS = parseInt(process.env.AAP_MAX_REGISTROS) || 0;
const PAUSA_LOTE_MS = parseInt(process.env.AAP_PAUSA_LOTE_MS) || 0;
const MAX_ERROR_PCT = parseFloat(process.env.AAP_MAX_ERROR_PCT) || 0;
const MAX_REGULA_MS = parseInt(process.env.AAP_MAX_REGULA_MS) || 0;

// Valores del campo procesada
const ESTATUS = {
    PENDIENTE: 0,
    ENROLADO: 1,
    ERROR: 4,     // Error definitivo (sin foto, imagen inválida, sin rostro)
    REINTENTO: 5  // Error transitorio, se regresa a PENDIENTE al iniciar la siguiente ejecución
};

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
        const error = new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
        error.transitorio = true;
        throw error;
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
            headers: {
                "x-api-secret": BIOMETRIC_API_SECRET
            },
            timeout: 30000
        });
        // El backend intermedio responde SUCCESS con "Duplicado por hash" cuando la imagen ya estaba enrolada
        const duplicado = /duplicado/i.test(String(resp.data && resp.data.message || ''));
        return { success: true, duplicado, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        const error = new Error(`Error en REGULA FACE API: ${errorMsg}`);
        error.transitorio = esErrorTransitorio(err);
        throw error;
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
                const regulaStart = Date.now();
                try {
                    const base64 = bufferToBase64(row.foto);
                    const resp = await procesarImagen(base64, row);

                    return {
                        id_foto_interno: row.id_foto_interno,
                        estatus: resp.success === true ? ESTATUS.ENROLADO : ESTATUS.ERROR,
                        duplicado: resp.duplicado,
                        regulaTime: Date.now() - regulaStart
                    };

                } catch (err) {
                    console.error(`ID_FOTO_INTERNO: ${row.id_foto_interno} [${err.transitorio ? 'reintento' : 'error'}] -> `, err.message);
                    return {
                        id_foto_interno: row.id_foto_interno,
                        estatus: err.transitorio ? ESTATUS.REINTENTO : ESTATUS.ERROR,
                        regulaTime: Date.now() - regulaStart
                    };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    // Actualización de estados masiva: 1 = enrolado, 4 = error, 5 = reintento
    const updateStart = Date.now();

    for (const estatus of [ESTATUS.ENROLADO, ESTATUS.ERROR, ESTATUS.REINTENTO]) {
        const ids = resultados.filter(r => r.estatus === estatus).map(r => r.id_foto_interno);
        if (ids.length === 0) continue;

        const request = pool.request().input('estatus', sql.Int, estatus);
        ids.forEach((id, i) => request.input(`id${i}`, sql.Int, id));
        await request.query(`UPDATE Fotos_Internos SET procesada = @estatus WHERE id_foto_interno IN (${ids.map((_, i) => `@id${i}`).join(', ')})`);
    }

    const updateTime = Date.now() - updateStart;

    const conteo = estatus => resultados.filter(r => r.estatus === estatus).length;
    const duplicados = resultados.filter(r => r.duplicado).length;
    const reintentos = conteo(ESTATUS.REINTENTO);
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (rows.length || 1);

    console.log(`   ⏱ Lote ${rows.length} (✅ ${conteo(ESTATUS.ENROLADO) - duplicados} | ♻ duplicados ${duplicados} | ❌ ${conteo(ESTATUS.ERROR)} | 🔁 reintento ${reintentos}): Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s | DB Update: ${(updateTime / 1000).toFixed(1)}s`);

    return { total: rows.length, reintentos, avgRegula };
}

/**
 * Función principal del worker para SQL Server.
 */
async function taskAapCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento AAP (SQL Server) [${new Date().toLocaleString()}] ---`);

    const control = crearControlCarga({
        sistema: 'AAP',
        lote: LOTE,
        maxRegistros: MAX_REGISTROS,
        maxErrorPct: MAX_ERROR_PCT,
        maxRegulaMs: MAX_REGULA_MS
    });

    let pool;
    try {
        pool = await getAapPool();

        // Regresar a pendiente los errores transitorios de ejecuciones anteriores
        const reactivados = await pool.request()
            .input('pendiente', sql.Int, ESTATUS.PENDIENTE)
            .input('reintento', sql.Int, ESTATUS.REINTENTO)
            .query(`UPDATE Fotos_Internos SET procesada = @pendiente WHERE procesada = @reintento`);

        const pendientes = await pool.request()
            .input('pendiente', sql.Int, ESTATUS.PENDIENTE)
            .query(`SELECT COUNT(*) AS total FROM Fotos_Internos WHERE procesada = @pendiente`);

        console.log(control.descripcion());
        console.log(`🔁 Reintentos reactivados: ${reactivados.rowsAffected[0]} | 📋 Pendientes: ${pendientes.recordset[0].total}`);

        while (!control.debeDetener()) {
            const fetchStart = Date.now();
            const limite = control.reservarCupo();

            // Más recientes primero (índice IX_Fotos_Internos_Pendientes: procesada, id_foto_interno)
            const result = await pool.request()
                .input('limit', sql.Int, limite)
                .query(`
                    SELECT TOP (@limit)
                        id_foto_interno, id_centro, id_foto, numint, foto, fecha, procesada
                    FROM Fotos_Internos
                    WHERE procesada = 0
                    ORDER BY id_foto_interno DESC
                `);

            const rows = result.recordset;
            const fetchTime = Date.now() - fetchStart;
            control.liberarCupo(limite - rows.length);

            if (!rows || rows.length === 0) {
                console.log(`✅ No hay más registros pendientes de procesar.`);
                break;
            }

            console.log(`📦 Lote de ${rows.length} registros recuperado (SQL Fetch: ${fetchTime}ms)`);

            const resumen = await procesarLote(rows, pool);
            control.registrarLote(resumen, 'AAP');

            if (PAUSA_LOTE_MS > 0 && !control.debeDetener()) await esperar(PAUSA_LOTE_MS);
        }

        console.log(`🎉 Proceso AAP completo. ${control.resumenFinal()}`);

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento AAP:", err);
    }
}

module.exports = { taskAapCheck };
