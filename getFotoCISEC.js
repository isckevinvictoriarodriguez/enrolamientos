const fs = require('fs');
const path = require('path');
const { getCisecPool, sql, closeCisecPool } = require('./db/cisec_config.js');

async function getFoto(tipo, valor) {
    if (!['p_id', 'p_curp'].includes(tipo)) {
        console.error("❌ El tipo de búsqueda debe ser 'p_id' o 'p_curp'");
        process.exit(1);
    }

    console.log(`Buscando registro por ${tipo} = '${valor}'...`);

    try {
        const pool = await getCisecPool();

        // Se asume que la vista/tabla es CECC_FC según las últimas modificaciones
        const query = `
            SELECT p_id, p_curp, p_pic 
            FROM CECC_FC 
            WHERE ${tipo} = @valor
        `;

        const result = await pool.request()
            .input('valor', sql.VarChar, valor)
            .query(query);

        if (result.recordset.length === 0) {
            console.log(`⚠️ No se encontró ningún registro con ${tipo} = '${valor}'`);
            return;
        }

        const row = result.recordset[0];
        const buffer = row.p_pic;

        if (!buffer) {
            console.log(`⚠️ El registro encontrado no tiene datos en la columna p_pic (foto nula).`);
            return;
        }

        // Convertir buffer a base64
        const base64 = buffer.toString('base64');

        // Construir nombres de archivo basados en el CURP (o ID si no hay CURP)
        const filenameBase = `${row.p_curp || row.p_id}`;
        const imgPath = path.join(__dirname, `fotos/CISEC/imgs/${filenameBase}.jpg`);
        const txtPath = path.join(__dirname, `fotos/CISEC/files/${filenameBase}_base64.txt`);

        // Escribir el buffer binario en un archivo JPG
        fs.writeFileSync(imgPath, buffer);
        console.log(`✅ Imagen binaria guardada exitosamente en: ${imgPath}`);

        // Escribir la cadena base64 en un archivo de texto
        fs.writeFileSync(txtPath, base64);
        console.log(`✅ Cadena Base64 guardada exitosamente en: ${txtPath}`);

    } catch (err) {
        console.error("❌ Error al consultar la base de datos o guardar los archivos:", err.message);
    } finally {
        await closeCisecPool();
        process.exit(0);
    }
}

const argTipo = process.argv[2];
const argValor = process.argv[3];

if (!argTipo || !argValor) {
    console.log("=================================================");
    console.log(" USO INCORRECTO. Faltan parámetros.");
    console.log("=================================================");
    console.log("Uso: node getFotoCISEC.js <p_id|p_curp> <valor>");
    console.log("Ejemplo 1: node getFotoCISEC.js p_id 100500");
    console.log("Ejemplo 2: node getFotoCISEC.js p_curp ABCDEF1234567890");
    console.log("=================================================");
    process.exit(1);
}

getFoto(argTipo, argValor);
