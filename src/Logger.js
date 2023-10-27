//Provides internal logging

import winston from 'winston';
import moment from 'moment';
import { MESSAGE } from 'triple-beam';

const TAIL_SIZE = 5;

let pathTemplate = null;
let path = null;
let logger = null;
let useConsole = false;
let _tail = [];

export function setPathTemplate(newPathTemplate) {
    if (pathTemplate == newPathTemplate) return;
    pathTemplate = newPathTemplate;
    path = null;
    logger = null;
}

export function enableConsole() {
    useConsole = true;
}


export const logFormat = winston.format((info, opts) => {
    let result = moment().format('YYYY-MM-DD HH:mm:ss') + ' [' + info.level.toUpperCase() + '] ';
    if (typeof info.message == "object") {
        result += "<<<\n" + JSON.stringify(info.message) + "\n>>>";
    } else {
        result += info.message;
    }
    info[MESSAGE] = result;
    return info;
});


function ready() {
    if (!pathTemplate) return false;
    
    let desiredPath = moment().format(pathTemplate);
    if (!logger || path != desiredPath) {
        path = desiredPath;
        //console.log('Log open: ' + path);

        logger = winston.createLogger({
            transports: [
                new (winston.transports.File)({
                    filename: path
                })
            ],
            format: logFormat()
        });
        
        if (useConsole) {
            logger.add(new winston.transports.Console());
        }

        logger.info('============================== Session start ==============================');
    }
    
    return !!logger;
}


export function log(method, subject) {
    
    if (!ready()) {
        if (typeof subject != "object") {
            console.log('[' + method.toUpperCase() + '] ' + subject);
        } else {
            console.log('[' + method.toUpperCase() + '] <<<');
            console.log(subject);
            console.log('>>>');
        }
        return null;
    }
    
    var actualMethod;
    switch (method) {
        case 'debug': actualMethod = logger.debug; break;
        case 'warn': actualMethod = logger.warn; break;
        case 'error': actualMethod = logger.error; break;
        default: actualMethod = logger.info;
    }
    
    _tail.push({level: method, message: subject});
    if (_tail.length > TAIL_SIZE) _tail.shift();

    return actualMethod.apply(null, [subject]);
}

export function debug(subject) {
    return log('debug', subject);
}
export function info(subject) {
    return log('info', subject);
}
export function warn(subject) {
    return log('warn', subject);
}
export function error(subject) {
    return log('error', subject);
}

export function tail(count) {
    if (!count || count < 1) count = 1;
    if (count > TAIL_SIZE) count = TAIL_SIZE;
    return _tail.slice(0, count);
}

export function onFinish(callback) {
    logger.on('finish', callback);
}

export default { setPathTemplate, enableConsole, logFormat, log, debug, info, warn, error, tail, onFinish };