/**
 * Calcula la fecha límite de ejecución de los enrolamientos.
 * - ENROL_FECHA_LIMITE (ISO): la envía el scheduler a cada script de la cola.
 * - ENROL_HORA_LIMITE (HH:MM): próxima ocurrencia de esa hora a partir de `desde`.
 * Regresa null si no hay límite configurado.
 */
function calcularFechaLimite(desde = new Date()) {
    if (process.env.ENROL_FECHA_LIMITE) {
        const fecha = new Date(process.env.ENROL_FECHA_LIMITE);
        if (!isNaN(fecha)) return fecha;
    }

    const hora = process.env.ENROL_HORA_LIMITE;
    if (!hora) return null;

    const match = /^(\d{1,2}):(\d{2})$/.exec(hora.trim());
    if (!match) {
        console.warn(`ENROL_HORA_LIMITE inválida (${hora}), se ignora. Formato esperado HH:MM`);
        return null;
    }

    const limite = new Date(desde);
    limite.setHours(parseInt(match[1]), parseInt(match[2]), 0, 0);
    if (limite <= desde) limite.setDate(limite.getDate() + 1);
    return limite;
}

module.exports = { calcularFechaLimite };
