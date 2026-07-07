const { spawn } = require('child_process');

console.log("Iniciando Programador (Scheduler) de Enrolamientos...");
console.log("- AAP: Lunes a las 11:00 AM");
console.log("- CISEC: Martes a las 11:00 AM");
console.log("- DGA: Miércoles a las 11:00 AM");
console.log("- ICV: Jueves a las 11:00 AM");

// Mapa de día de la semana (0=Domingo, 1=Lunes, ..., 4=Jueves) al script correspondiente
const scheduleMap = {
    1: 'enrolamientoAAP.js',   // Lunes
    2: 'enrolamientoCISEC.js', // Martes
    3: 'enrolamientoDGA.js',   // Miércoles
    4: 'testEnrolamietoICV.js' // Jueves
};

let lastRunDay = -1;

function checkTime() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Revisa si son las 11:00 AM, si hay una tarea para hoy, y si no se ha ejecutado hoy
    if (hour === 11 && minute === 0 && scheduleMap[dayOfWeek] && lastRunDay !== dayOfWeek) {
        lastRunDay = dayOfWeek; // Marcar que ya corrió hoy
        const scriptName = scheduleMap[dayOfWeek];
        console.log(`[${now.toLocaleString()}] ¡Es la hora! Ejecutando tarea programada: ${scriptName}`);

        const child = spawn('node', [scriptName], { stdio: 'inherit', shell: true });

        child.on('close', (code) => {
            console.log(`[${new Date().toLocaleString()}] Tarea ${scriptName} finalizada con código ${code}`);
        });
    }

    // Reiniciar la variable de control pasada la media noche
    if (hour === 0 && minute === 0) {
        lastRunDay = -1;
    }
}

// Revisar cada 30 segundos
setInterval(checkTime, 30000);
