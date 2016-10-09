var winston = require('winston');
var moment = require('moment');

var pathTemplate = null;
var path = null;
var logger = null;

exports.setPathTemplate = function(newPathTemplate) {
    if (pathTemplate == newPathTemplate) return;
    pathTemplate = newPathTemplate;
    path = null;
    logger = null;
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
                    formatter: (args) => '[' + args.level.toUpperCase() + '] ' + args.message
                })
            ]
        });
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
        case 'warning': actualMethod = logger.warning; break;
        case 'error': actualMethod = logger.error; break;
        default: actualMethod = logger.info;
    }
    
    return actualMethod.apply(null, [subject]);

}

exports.info = function(subject) {
    return log('info', subject);
}
exports.warning = function(subject) {
    return log('warning', subject);
}
exports.error = function(subject) {
    return log('error', subject);
}
