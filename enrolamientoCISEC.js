const { taskCisecCheck } = require('./cisecEnrolamientos/enrolamiento');

taskCisecCheck()
    .then(() => {
        console.log("🎉 Proceso CISEC terminado exitosamente.");
        process.exit(0);
    })
    .catch(err => {
        console.error("❌ Error en el script principal de CISEC:", err);
        process.exit(1);
    });
