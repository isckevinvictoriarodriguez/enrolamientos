const { spawn } = require('child_process');

console.log("Iniciando Programador (Scheduler) de Enrolamientos...");
console.log("- CISEC: Lunes a las 12:00 PM");
console.log("- AAP: Martes a las 12:00 PM");
console.log("- DGA: Miércoles a las 12:00 PM");
console.log("- ICV: Jueves a las 12:00 PM");

// Mapa de día de la semana (0=Domingo, 1=Lunes, ..., 4=Jueves) al script correspondiente
const scheduleMap = {
    1: 'enrolamientoCISEC.js', // Lunes
    2: 'enrolamientoAAP.js',   // Martes
    3: 'enrolamientoDGA.js',   // Miércoles
    4: 'testEnrolamietoICV.js' // Jueves
};

let lastRunDay = -1;

function checkTime() {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Revisa si son las 12:00 PM, si hay una tarea para hoy, y si no se ha ejecutado hoy
    if (hour === 12 && minute === 0 && scheduleMap[dayOfWeek] && lastRunDay !== dayOfWeek) {
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
