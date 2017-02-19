var winston = require('winston');
var moment = require('moment');

var pathTemplate = null;
var path = null;
var logger = null;
var useConsole = false;

exports.setPathTemplate = function(newPathTemplate) {
    if (pathTemplate == newPathTemplate) return;
    pathTemplate = newPathTemplate;
    path = null;
    logger = null;
}

exports.enableConsole = function() {
    useConsole = true;
}


function ready() {
    if (!pathTemplate) return false;
    
    var desiredPath = moment().format(pathTemplate);
    if (!logger || path != desiredPath) {
        path = desiredPath;
        console.log('Log open: ' + path);

        logger = new (winston.Logger)({
            transports: [
                new (winston.transports.File)({
                    filename: path,
                    json: false,
                    timestamp: () => moment().format('YYYY-MM-DD HH:mm:ss'),
                    prettyPrint: true,
                    formatter: (args) => {
                        var result = moment().format('YYYY-MM-DD HH:mm:ss') + ' [' + args.level.toUpperCase() + '] ';
                        if (typeof args.message == "object") {
                            result += "<<<\n" + JSON.stringify(args.message) + "\n>>>";
                        } else {
                            result += args.message;
                        }
                        return result;
                    }
                })
            ]
        });
        
        if (useConsole) {
            logger.add(winston.transports.Console, {});
        }

        logger.info('Session start');
    }
    
    return !!logger;
}


var log = exports.log = function(method, subject) {
    
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
