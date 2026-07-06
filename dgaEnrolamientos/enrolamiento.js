const axios = require('axios');
const pLimit = require('p-limit');

// CONFIGURACIÓN desde .env
const DGA_API_KEY = process.env.DGA_API_KEY;
const LIMIT = parseInt(process.env.DGA_LIMIT) || 5;
const START_OFFSET = parseInt(process.env.DGA_OFFSET) || 1;
const DGA_REGULA_GROUP_ID = process.env.DGA_REGULA_GROUP_ID;
const DGA_CONCURRENCIA = parseInt(process.env.DGA_CONCURRENCIA) || 5;
const DGA_API_URL = process.env.DGA_API_URL || 'https://siass.nl.gob.mx/api/v1/fa7d8939f8914340847371e3d7afaf70';
const DGA_COOLDOWN_MS = parseInt(process.env.DGA_COOLDOWN_MS) || 2000; // Cooldown de 2 segundos por defecto

const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const BIOMETRIC_API_SECRET = process.env.BIOMETRIC_API_SECRET || '';

/**
 * Utilidad de sleep/delay.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Realiza peticiones GET con reintentos inteligentes ante códigos de estado de límite de tasa (HTTP 429).
 */
async function fetchWithRetry(url, options = {}, retries = 5, delayMs = 5000) {
    try {
        return await axios.get(url, options);
    } catch (err) {
        const status = err.response ? err.response.status : null;
        const isNetworkError = !err.response || err.code === 'ECONNRESET' || err.message.includes('socket hang up') || err.code === 'ETIMEDOUT';

        if ((status === 429 || isNetworkError) && retries > 0) {
            const reason = status === 429 ? 'Límite de peticiones (429)' : `Error de red/conexión (${err.code || err.message})`;
            console.warn(`⚠️ ${reason}. Reintentando en ${delayMs / 1000}s... (${retries} reintentos restantes)`);
            await sleep(delayMs);
            return fetchWithRetry(url, options, retries - 1, delayMs * 1.5);
        }
        throw err;
    }
}

/**
 * Procesa el enrolamiento en la API de Regula.
 * @param {string} base64 - Imagen en formato base64
 * @param {object} employee - Datos del empleado (contiene id, numero_empleado)
 */
async function procesarImagen(base64, employee) {
    if (!base64) {
        throw new Error(`Base64 de imagen vacío para el empleado ID: ${employee?.id}, omitiendo enrolamiento.`);
    }

    if (!REGULA_URL || !DGA_REGULA_GROUP_ID) {
        throw new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
    }

    // Como filename vamos a utilizar numero_empleado
    const filename = String(employee.numero_empleado);

    const payload = {
        image_base64: base64,
        filename: filename,
        group_ids: [DGA_REGULA_GROUP_ID],
        metadata: {
            id: employee.id,
            numero_empleado: employee.numero_empleado
        }
    };

    try {
        const resp = await axios.post(REGULA_URL, payload, {
            headers: {
                "x-api-secret": BIOMETRIC_API_SECRET
            },
            timeout: 30000 // 30 segundos
        });
        return { success: true, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        throw new Error(`Error en REGULA FACE API para numero_empleado: ${employee.numero_empleado} -> ${errorMsg}`);
    }
}

/**
 * Procesa un lote de empleados en paralelo.
 */
async function procesarLote(employees) {
    const limit = pLimit(DGA_CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        employees.map(employee =>
            limit(async () => {
                let regulaTime = 0;
                try {
                    const regulaStart = Date.now();
                    const base64 = employee.image_256;
                    const resp = await procesarImagen(base64, employee);
                    regulaTime = Date.now() - regulaStart;

                    return {
                        id: employee.id,
                        numero_empleado: employee.numero_empleado,
                        ok: resp.success === true,
                        regulaTime
                    };
                } catch (err) {
                    console.error(`ID: ${employee.id} | Numero Empleado: ${employee.numero_empleado} -> Error: ${err.message}`);
                    return {
                        id: employee.id,
                        numero_empleado: employee.numero_empleado,
                        ok: false,
                        regulaTime: 0
                    };
                }
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (employees.length || 1);

    console.log(`   ⏱ Lote ${employees.length}: Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s`);

    return resultados;
}

/**
 * Función principal del worker para DGA.
 */
async function taskDgaCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento DGA [${new Date().toLocaleString()}] ---`);
    console.log(`URL API DGA: ${DGA_API_URL}`);
    console.log(`Regula URL: ${REGULA_URL}`);
    console.log(`Grupo Regula: ${DGA_REGULA_GROUP_ID}`);

    let offset = START_OFFSET;
    let paginasProcesadas = 0;
    let totalExitosos = 0;
    let totalFallidos = 0;

    try {
        while (true) {
            const fetchStart = Date.now();
            console.log(`\n🔄 Solicitando página (Offset: ${offset}, Limit: ${LIMIT})...`);

            const url = `${DGA_API_URL}?api_key=${DGA_API_KEY}&limit=${LIMIT}&offset=${offset}`;
            const resp = await fetchWithRetry(url, { timeout: 30000 });

            const responseData = resp.data;
            const data = responseData?.data || [];
            const pagination = responseData?.pagination || {};
            const fetchTime = Date.now() - fetchStart;

            console.log(`📦 Datos recuperados: ${data.length} registros (Fetch: ${fetchTime}ms)`);
            if (pagination.total !== undefined) {
                console.log(`📊 Progreso: offset ${offset} de ${pagination.total} totales.`);
            }

            if (data.length === 0) {
                console.log(`✅ No hay más registros pendientes de procesar en el API de DGA.`);
                break;
            }

            const resultadosLote = await procesarLote(data);

            const exitosos = resultadosLote.filter(r => r.ok).length;
            const fallidos = resultadosLote.filter(r => !r.ok).length;
            totalExitosos += exitosos;
            totalFallidos += fallidos;

            paginasProcesadas++;

            // Validar si alcanzamos el total reportado por la paginación para evitar bucles
            if (pagination.total !== undefined && offset + data.length - 1 >= pagination.total) {
                console.log(`✅ Se alcanzó el total de registros disponibles en DGA (${pagination.total}).`);
                break;
            }

            // Incrementar el offset en código
            offset += LIMIT;

            // Esperar cooldown para no saturar el servidor
            if (DGA_COOLDOWN_MS > 0) {
                await sleep(DGA_COOLDOWN_MS);
            }
        }

        console.log(`\n🎉 Proceso DGA completo.`);
        console.log(`📊 Resumen final:`);
        console.log(`   - Páginas procesadas: ${paginasProcesadas}`);
        console.log(`   - Enrolados con éxito: ${totalExitosos}`);
        console.log(`   - Fallidos: ${totalFallidos}`);

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento DGA:", err.message);
    }
}

module.exports = { taskDgaCheck };
