const { spawn } = require('child_process');

console.log("Iniciando Programador (Scheduler) de Enrolamientos...");
console.log("- AAP: Lunes a las 1:00 AM");
console.log("- CISEC: Martes a las 1:00 AM");
console.log("- DGA: Miércoles a las 1:00 AM");
console.log("- ICV: Jueves a las 1:00 AM");
console.log("- AAP: Viernes a las 1:00 AM");
console.log("- DGA: Sábado a las 1:00 AM");
console.log("- ICV: Domingo a las 1:00 AM");

// Mapa de día de la semana (0=Domingo, 1=Lunes, ..., 4=Jueves) al script correspondiente
const scheduleMap = {
    1: 'enrolamientoAAP.js',   // Lunes
    2: 'enrolamientoCISEC.js', // Martes
    3: 'enrolamientoDGA.js',   // Miércoles
    // 4: 'enrolamientoICV.js', // Jueves
    5: 'enrolamientoAAP.js', // Viernes
    6: 'enrolamientoDGA.js', // Sábado
    // 7: 'enrolamientoICV.js', // Domingo
};

let lastRunDay = -1;

function checkTime() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Revisa si son las 01:00 AM, si hay una tarea para hoy, y si no se ha ejecutado hoy
    if (hour === 1 && minute === 0 && scheduleMap[dayOfWeek] && lastRunDay !== dayOfWeek) {
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
