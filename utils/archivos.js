const fs = require('fs');
const path = require('path');

function pausaSincrona(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Lee un archivo JSON de estado. Si está corrupto se renombra a .corrupto-<fecha>
 * para diagnóstico, se advierte en el log y se regresa el valor por defecto.
 */
function leerJson(file, valorDefault) {
    if (!fs.existsSync(file)) return valorDefault;

    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        const respaldo = `${file}.corrupto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
            fs.renameSync(file, respaldo);
        } catch (e) { }
        console.warn(`⚠️ Archivo de estado corrupto ${path.basename(file)} (${err.message}). Respaldado como ${path.basename(respaldo)}, se usa el valor por defecto`);
        return valorDefault;
    }
}

/**
 * Escritura atómica: se escribe a un temporal y se renombra, así el archivo
 * queda completo o se conserva el anterior si el proceso muere a mitad.
 */
function guardarJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');

    // En Windows el rename puede fallar momentáneamente si otro proceso (antivirus) tiene abierto el archivo
    for (let intento = 1; ; intento++) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch (err) {
            if (intento >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
            pausaSincrona(100 * intento);
        }
    }
}

module.exports = { leerJson, guardarJson };
