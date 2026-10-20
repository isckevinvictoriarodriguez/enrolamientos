require('dotenv').config();
const { taskDgaCheck } = require('./dgaEnrolamientos/enrolamiento.js');

// Ejecutar el proceso de enrolamiento DGA
// Se termina el proceso explícitamente para que el scheduler pueda continuar con la cola
taskDgaCheck()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("❌ Error en el script principal de DGA:", err);
        process.exit(1);
    });
