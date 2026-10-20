const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const pLimit = require('p-limit');
const { crearControlCarga, esErrorTransitorio } = require('../utils/controlCarga.js');

// CONFIGURACIÓN desde .env
const DGA_API_KEY = process.env.DGA_API_KEY;
const LIMIT = parseInt(process.env.DGA_LIMIT) || 50;
const START_OFFSET = parseInt(process.env.DGA_OFFSET) || 1;
const DGA_REGULA_GROUP_ID = process.env.DGA_REGULA_GROUP_ID;
const DGA_CONCURRENCIA = parseInt(process.env.DGA_CONCURRENCIA) || 5;
const DGA_API_URL = process.env.DGA_API_URL || 'https://siass.nl.gob.mx/api/v1/fa7d8939f8914340847371e3d7afaf70';
const DGA_COOLDOWN_MS = parseInt(process.env.DGA_COOLDOWN_MS) || 2000; // Cooldown de 2 segundos por defecto

// Control de carga (0 = deshabilitado). El tope cuenta envíos a Regula, no registros leídos del API
const MAX_REGISTROS = parseInt(process.env.DGA_MAX_REGISTROS) || 0;
const MAX_ERROR_PCT = parseFloat(process.env.DGA_MAX_ERROR_PCT) || 0;
const MAX_REGULA_MS = parseInt(process.env.DGA_MAX_REGULA_MS) || 0;

const REGULA_URL = process.env.REGULA_URL ? process.env.REGULA_URL + '/api/v1/faces/upload' : null;
const BIOMETRIC_API_SECRET = process.env.BIOMETRIC_API_SECRET || '';

// Caché de fotos enviadas (numero_empleado -> hash) y cursor de paginación entre ejecuciones
const CACHE_FILE = path.join(__dirname, 'dga_enrolados.json');
const CURSOR_FILE = path.join(__dirname, 'dga_cursor.json');

// Limpia caché y cursor para reenviar todo (los duplicados los descarta el backend por nombre y hash)
const REINICIAR = process.argv.includes('--reiniciar');

const ESTADO = { ENROLADO: 'enrolado', DUPLICADO: 'duplicado', ERROR: 'error', REINTENTO: 'reintento' };

/**
 * Utilidad de sleep/delay.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function leerJson(file, valorDefault) {
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) { }
    }
    return valorDefault;
}

function guardarJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}

function claveEmpleado(employee) {
    return String(employee.numero_empleado ?? employee.id);
}

function hashImagen(base64) {
    return crypto.createHash('sha256').update(base64 || '').digest('hex');
}

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
        const error = new Error("CONFIGURACIÓN DE REGULA NO ENCONTRADA (Verificar .env)");
        error.transitorio = true;
        throw error;
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
        // El backend intermedio responde SUCCESS con "Duplicado por hash" cuando la imagen ya estaba enrolada
        const duplicado = /duplicado/i.test(String(resp.data && resp.data.message || ''));
        return { success: true, duplicado, data: resp.data };
    } catch (err) {
        const errorData = err.response ? err.response.data : null;
        const errorMsg = errorData ? JSON.stringify(errorData) : err.message;
        const error = new Error(`Error en REGULA FACE API para numero_empleado: ${employee.numero_empleado} -> ${errorMsg}`);
        error.transitorio = esErrorTransitorio(err);
        throw error;
    }
}

/**
 * Procesa en paralelo los empleados cuya foto no está en caché o cambió.
 * Enrolados, duplicados y errores definitivos se guardan en caché con su hash;
 * los transitorios no, para que se reintenten en la siguiente pasada.
 */
async function procesarLote(employees, cache) {
    const limit = pLimit(DGA_CONCURRENCIA);
    const startTime = Date.now();

    const resultados = await Promise.all(
        employees.map(employee =>
            limit(async () => {
                const regulaStart = Date.now();
                const base64 = employee.image_256;
                let estado;
                try {
                    const resp = await procesarImagen(base64, employee);
                    estado = resp.duplicado ? ESTADO.DUPLICADO : ESTADO.ENROLADO;
                } catch (err) {
                    console.error(`ID: ${employee.id} | Numero Empleado: ${employee.numero_empleado} [${err.transitorio ? 'reintento' : 'error'}] -> Error: ${err.message}`);
                    estado = err.transitorio ? ESTADO.REINTENTO : ESTADO.ERROR;
                }

                if (estado !== ESTADO.REINTENTO) {
                    cache[claveEmpleado(employee)] = {
                        hash: hashImagen(base64),
                        estado: estado === ESTADO.ERROR ? ESTADO.ERROR : ESTADO.ENROLADO,
                        fecha: new Date().toISOString()
                    };
                }

                return { estado, regulaTime: Date.now() - regulaStart };
            })
        )
    );

    const totalProcessingTime = Date.now() - startTime;

    const conteo = estado => resultados.filter(r => r.estado === estado).length;
    const reintentos = conteo(ESTADO.REINTENTO);
    const avgRegula = resultados.reduce((a, b) => a + b.regulaTime, 0) / (employees.length || 1);

    console.log(`   ⏱ Enviados ${employees.length} (✅ ${conteo(ESTADO.ENROLADO)} | ♻ duplicados ${conteo(ESTADO.DUPLICADO)} | ❌ ${conteo(ESTADO.ERROR)} | 🔁 reintento ${reintentos}): Regula Prom: ${avgRegula.toFixed(0)}ms | Total Proc: ${(totalProcessingTime / 1000).toFixed(1)}s`);

    return { total: employees.length, reintentos, avgRegula };
}

/**
 * Función principal del worker para DGA.
 */
async function taskDgaCheck() {
    console.log(`\n--- Inicio de Proceso Enrolamiento DGA [${new Date().toLocaleString()}] ---`);
    console.log(`URL API DGA: ${DGA_API_URL}`);
    console.log(`Regula URL: ${REGULA_URL}`);
    console.log(`Grupo Regula: ${DGA_REGULA_GROUP_ID}`);

    const control = crearControlCarga({
        sistema: 'DGA',
        lote: LIMIT,
        maxRegistros: MAX_REGISTROS,
        maxErrorPct: MAX_ERROR_PCT,
        maxRegulaMs: MAX_REGULA_MS
    });

    if (REINICIAR) {
        console.log('🔄 --reiniciar: se limpian caché y cursor, se reenviará todo');
        guardarJson(CACHE_FILE, {});
        guardarJson(CURSOR_FILE, { offset: START_OFFSET });
    }

    const cache = leerJson(CACHE_FILE, {});
    let offset = parseInt(leerJson(CURSOR_FILE, {}).offset) || START_OFFSET;
    let paginasProcesadas = 0;
    let omitidos = 0;

    console.log(`${control.descripcion()} | Cursor: offset ${offset} | Empleados en caché: ${Object.keys(cache).length}`);

    try {
        while (!control.debeDetener()) {
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
                console.log(`✅ No hay más registros pendientes de procesar en el API de DGA. Vuelta completa, el cursor regresa a ${START_OFFSET}.`);
                guardarJson(CURSOR_FILE, { offset: START_OFFSET });
                break;
            }

            // Solo se envían los empleados nuevos o con foto distinta a la de caché
            const pendientes = data.filter(employee => {
                const previo = cache[claveEmpleado(employee)];
                return !previo || previo.hash !== hashImagen(employee.image_256);
            });
            omitidos += data.length - pendientes.length;

            // El tope se aplica por página completa, puede excederse hasta en LIMIT - 1 envíos
            const cupo = control.reservarCupo();
            control.liberarCupo(cupo - pendientes.length);

            if (pendientes.length > 0) {
                const resumen = await procesarLote(pendientes, cache);
                guardarJson(CACHE_FILE, cache);

                // Con saturación el cursor no avanza: la siguiente ejecución reintenta esta misma página
                if (control.registrarLote(resumen, `offset ${offset}`)) break;
            } else {
                console.log(`   ⏭ Sin cambios en esta página, se omite el envío`);
            }

            paginasProcesadas++;

            // Validar si alcanzamos el total reportado por la paginación para evitar bucles
            if (pagination.total !== undefined && offset + data.length - 1 >= pagination.total) {
                console.log(`✅ Se alcanzó el total de registros disponibles en DGA (${pagination.total}). Vuelta completa, el cursor regresa a ${START_OFFSET}.`);
                guardarJson(CURSOR_FILE, { offset: START_OFFSET });
                break;
            }

            // Incrementar el offset en código y guardarlo para continuar en la siguiente ejecución si se detiene
            offset += LIMIT;
            guardarJson(CURSOR_FILE, { offset });

            // Esperar cooldown para no saturar el servidor
            if (DGA_COOLDOWN_MS > 0 && !control.debeDetener()) {
                await sleep(DGA_COOLDOWN_MS);
            }
        }

        console.log(`\n🎉 Proceso DGA completo.`);
        console.log(`📊 Resumen final:`);
        console.log(`   - Páginas procesadas: ${paginasProcesadas}`);
        console.log(`   - ${control.resumenFinal()}`);
        console.log(`   - Omitidos sin cambios: ${omitidos}`);

    } catch (err) {
        console.error("❌ Error general en el proceso de enrolamiento DGA:", err.message);
    }
}

module.exports = { taskDgaCheck };
