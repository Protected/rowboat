//Provides internal logging

const winston = require('winston');
const moment = require('moment');

const { MESSAGE } = require('triple-beam');

let pathTemplate = null;
let path = null;
let logger = null;
let useConsole = false;

exports.setPathTemplate = function(newPathTemplate) {
    if (pathTemplate == newPathTemplate) return;
    pathTemplate = newPathTemplate;
    path = null;
    logger = null;
}

exports.enableConsole = function() {
    useConsole = true;
}


const logFormat = winston.format((info, opts) => {
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
        console.log('Log open: ' + path);

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


let log = exports.log = function(method, subject) {
    
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
    

    return actualMethod.apply(null, [subject]);
}

exports.debug = function(subject) {
    return log('debug', subject);
}
exports.info = function(subject) {
    return log('info', subject);
}
exports.warn = function(subject) {
    return log('warn', subject);
}
exports.error = function(subject) {
    return log('error', subject);
}
