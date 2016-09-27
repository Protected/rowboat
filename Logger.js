var winston = require('winston');
var jsonfile = require('jsonfile');

var config = jsonfile.readFileSync("config/config.json");

if ( config && config.logger && config.logger.outputFile) {
    var loggerFile = config.logger.outputFile;
    module.exports = new (winston.Logger)({
        transports: [
            new (winston.transports.File)({ filename: loggerFile })
        ]
    });
} else {
    module.exports = null;
}

