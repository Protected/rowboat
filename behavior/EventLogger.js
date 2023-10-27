import winston from 'winston';
import moment from 'moment';
import fs from 'fs';
import cp from 'child_process';

import Behavior from '../src/Behavior.js';

import { MESSAGE } from 'triple-beam';

const logFormat = winston.format((info, opts) => {
    info[MESSAGE] = info.message;
    return info;
});

export default class EventLogger extends Behavior {

    get description() { return "Event logging for environments and behaviors"; }

    get params() { return [
        {n: 'basePath', d: "Path to the logs directory"},
        {n: 'logs', d: "List of: {outputFile: TEMPLATE, channels: [LOGCHANNEL, ...]} where the outputFile is a moment template relative to basePath (must end in .log)"},
        {n: 'templateJoin', d: "Template for join event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel%"},
        {n: 'templatePart', d: "Template for part event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel% %reason%"},
        {n: 'templateMessage', d: "Template for message event logs. Placeholders: %(MOMENT_FORMAT)% %env% %userid% %user% %channelid% %channel% %type% %message%"},
        {n: 'maxResults', d: "Maximum results per search"}
    ]; }

    get defaults() { return {
        basePath: 'eventlogs',
        templateJoin: "%(HH:mm:ss)% {%env%} [%channel%] * Joins: %user% (%userid%)",
        templatePart: "%(HH:mm:ss)% {%env%} [%channel%] * Parts: %user% (%userid%) - %reason%",
        templateMessage: "%(HH:mm:ss)% {%env%} [%channel%] <%user%> %message%",
        maxResults: 5
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('EventLogger', name);
        
        this._logs = [];  //Initialized with param('logs') but each item also contains logger (points to winston logger).
        this._channels = {};        
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //Index channels
        
        this._logs = this.param('logs');
        for (let log of this._logs) {
            if (!log.outputFile || !log.outputFile.match(/\.log\]$/)) continue;
            if (!log.channels || !log.channels.length) continue;
            
            log.logger = null;
            log.openPath = null;
            
            for (let channel of log.channels) {
                if (!this._channels[channel]) {
                    this._channels[channel] = [];
                }
                this._channels[channel].push(log);
            }
        }

        //Register callbacks
        
        this.env().on('join', this.onJoin, this);
        this.env().on('part', this.onPart, this);
        this.env().on('message', this.onMessage, this);
        
        this.be('Commands').registerCommand(this, 'grep', {
            description: "Search the event logs.",
            args: ["pattern", "results", "filepattern"],
            minArgs: 1,
            permissions: [this.be("Users").defaultPermAdmin, this.be("Users").defaultPermMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let filepattern = null;
            if (args.filepattern) {
                filepattern = args.filepattern;
                let m = filepattern.match(/^\/(.*)\/$/);
                if (m) {
                    filepattern = m[1];
                } else {
                    filepattern = '^.*' + filepattern.replace(/ /g, '.*') + '.*$';
                }
                filepattern = RegExp(filepattern);
            }
            
            let pattern = args.pattern;
            let m = pattern.match(/^\/(.*)\/$/);
            if (m) {
                pattern = m[1];
            } else {
                pattern = '^.*' + pattern.replace(/ /g, '.*') + '.*$';
            }
            
            let maxResults = this.param('maxResults');
            if (args.results) maxResults = Math.min(maxResults, args.results);
        
            let results = 0;
        
            for (let loginfo of this.getLogPaths(filepattern)) {
                let logpath = loginfo[0];
                let logname = loginfo[1];

                let lines = "";
                try {
                    lines = cp.execSync('grep -E ' + escapeShell(pattern) + ' -- ' + escapeShell(logpath) + ' 2>/dev/null');
                } catch (e) {}
                lines = lines.toString().split("\n").reverse();

                for (let line of lines) {
                    if (!line.trim()) continue;
                
                    ep.reply(logname + ' ' + line);
                
                    results += 1;
                    if (maxResults && results >= maxResults) break;
                }
                    
                if (maxResults && results >= maxResults) break;
            }
            
            if (results) {
                ep.reply('Found ' + results + ' result' + (results != 1 ? 's' : '') + (results == maxResults ? ' (max)' : '') + '.');
            } else {
                ep.reply('Found nothing.');
            }
        
            return true;
        });
      
        return true;
    };
    
    
    // # Module code below this line #
    
    
    //Write to log; call this from dependent modules to log custom events
    
    write(logchannel, message) {
        if (!logchannel || !this._channels[logchannel]) return 0;
        
        let writes = 0;
        for (let log of this._channels[logchannel]) {
            
            if (!this.ready(log)) {
                if (!log.warned) {
                    this.log('warn', 'Unable to open event log with template "' + log.outputFile + '" for channel "' + logchannel + '".');
                    log.warned = true;
                }
                continue;
            }
        
            log.logger.info(message);
            writes += 1;
        }
        
        return writes;
    }
    
    
    //Write to log using a template and placeholder values
    
    templateWrite(logchannel, template, fields) {
        if (!fields) fields = {};
        if (!template) template = "";
        let message = template;
        
        message = message.replace(/%\(([^)]+)\)%/g, (match, format) => {
            return moment().format(format);
        });
        
        message = message.replace(/%([^%]+)%/g, (match, placeholder) => {
            if (fields[placeholder]) return fields[placeholder];
            return "";
        });
        
        return this.write(logchannel, message);
    }
    
    
    //Write to log using a template informally defined in this module's config; call from dependent modules if desired
    
    templateNameWrite(logchannel, templatename, fields) {
        if (!templatename) return false;
        
        let param = 'template' + templatename.charAt(0).toUpperCase() + templatename.slice(1);
        if (!this.param(param)) return false;
        
        return this.templateWrite(logchannel, this.param(param), fields);
    }
    
    
    //Event handlers
    
    onJoin(env, authorid, channelid, rawobj) {
        this.templateWrite("join", this.param("templateJoin"), {env: env.name, userid: authorid, user: env.idToDisplayName(authorid), channelid: channelid, channel: env.channelIdToDisplayName(channelid)});
    }
    
    
    onPart(env, authorid, channelid, rawobj) {
        let reason = rawobj.reason;
        let reasonstr = null;
        if (typeof reason == "object") {
            reasonstr = reason[0];
            if (reason[2]) reasonstr += ' by ' + reason[2];
            if (reason[1]) reasonstr += ' (' + reason[1] + ')';
        }
        this.templateWrite("part", this.param("templatePart"), {env: env.name, userid: authorid, user: env.idToDisplayName(authorid), channelid: channelid, channel: env.channelIdToDisplayName(channelid), reason: reasonstr});
    }
    
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        let channel = 'default';
        if (type == "regular" || type == "action") channel = 'public';
        if (type == "private" || type == "privateaction") channel = 'private';
        this.templateWrite(channel, this.param("templateMessage"), {env: env.name, userid: authorid, user: env.idToDisplayName(authorid), channelid: channelid, channel: env.channelIdToDisplayName(channelid), type: type, message: env.normalizeFormatting(message)});
    }
    
    
    //Auxiliary - Open or reopen a logger
    
    ready(log) {
        if (!log.outputFile) return false;
        
        let desiredPath = this.param('basePath') + '/' + moment().format(log.outputFile);
        if (!log.logger || log.openPath != desiredPath) {
            log.openPath = desiredPath;
            this.log('Log open: ' + desiredPath);

            log.logger = winston.createLogger({
                transports: [
                    new (winston.transports.File)({
                        filename: log.openPath
                    })
                ],
                format: logFormat()
            });
        }
        
        return !!log.logger;
    }
    
    
    //Auxiliary - List existing log files
    
    getLogPaths(filter) {
        let result = [];
        let paths = [this.param('basePath')];
        let path;
        while (path = paths.shift()) {
            for (let file of fs.readdirSync(path)) {
                if (file.match(/^\./)) continue;
                let filepath = path + '/' + file;
                if (filter && !filter.exec(filepath)) continue;
                if (fs.statSync(filepath).isDirectory()) {
                    paths.push(filepath);
                } else if (file.match(/\.log$/)) {
                    result.push([filepath, file]);
                }
            }
        }
        return result.reverse();
    };
    

}
