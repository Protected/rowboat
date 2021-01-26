/* Module: Time -- Adds a time command and timezone tracking. */

const Module = require('../Module.js');

const moment = require('moment-timezone');
const ct = require('countries-and-timezones');

const MAX_SAME_USERS = 20;

class ModTime extends Module {

    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Time', name);
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        

        this.mod("Commands").registerCommand(this, 'tz', {
            description: "Display or change your timezone.",
            details: [
                "The argument should be an IANA (tz) timezone denomination.",
                "Use '-' / 'default' / 'server' to unset your timezone and return to server time.",
                "You can find your timezone using this tool: http://www.timezoneconverter.com/cgi-bin/findzone.tzc",
                "A list of all timezones is available here: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
            ],
            args: ["timezone"],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
            
            if (!handle) {
                let user = this.mod("Users").getEnvUser(env.name, userid);
                if (!user) {
                    ep.reply("Unfortunately I couldn't create or retrieve your account. Please ask an administrator for manual assistance.");
                    return true;
                }
                handle = user.handle;
            }

            if (!args.timezone) {
                let timezone = this.mod("Users").getMeta(handle, "timezone");
                if (!timezone) {
                    ep.reply("Your timezone is not set.");
                } else {
                    let info = ct.getTimezone(timezone);
                    if (!info) {
                        ep.reply("Your timezone is: " + timezone);
                    } else {
                        let cinfo = ct.getCountry(info.country);
                        ep.reply("Your timezone is: " + timezone + " (" + info.utcOffsetStr + "). You are in " + cinfo.name + ".");
                    }
                }
                return true;
            }

            if (args.timezone.match(/^-|default|server$/i)) {
                this.mod("Users").delMeta(handle, "timezone");
                ep.reply("Timezone unset.");
                return true;
            }

            if (!args.timezone.match(/^UTC|GMT|[A-Z][A-Za-z]+\/([A-Za-z_/]+|GMT([+-][0-9]+)?)$/)) {
                ep.reply("Invalid timezone format. Timezone names must be Area/Location.");
                return true;
            }

            let info = ct.getTimezone(args.timezone);
            if (!info) {
                ep.reply("Timezone not found.");
                return true;
            }

            this.mod("Users").setMeta(handle, "timezone", info.name);
            ep.reply("Timezone set to " + info.name + " (" + info.utcOffsetStr + ").");
        
            return true;
        });


        this.mod("Commands").registerCommand(this, 'time', {
            description: "Retrieve the current time.",
            details: [
                "By default displays time in your timezone (if set) or in the server timezone.",
                "The argument can be:",
                "'-' / 'default' / 'server': Force server time.",
                "Any IANA (tz) timezone denomination: Use the given timezone.",
                "Offset: Use the given offset in relation to UTC.",
                "USERNAME or =HANDLE: Use the timezone associated with a username or handle."
            ],
            args: ["timezone", true],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let timezone = null;
            let offset = null;
            let reqzone = args.timezone.join(" ");

            if (reqzone) {
                if (!reqzone.match(/^-|default|server$/i)) {
                    let info = ct.getTimezone(reqzone);
                    if (info) {
                        timezone = info.name;
                    } else if (reqzone.match(/^[+-][0-9]{2}:[0-9]{2}$/)) {
                        offset = reqzone;
                    } else {
                        let checkhandle = reqzone.match(/^=(.*)$/);
                        if (checkhandle) {
                            timezone = this.mod("Users").getMeta(checkhandle[1], "timezone");
                        } else {
                            let handles = this.mod("Users").getHandlesById(env.name, env.displayNameToId(reqzone) || reqzone);
                            if (handles.length) {
                                timezone = this.mod("Users").getMeta(handles[0], "timezone");
                            }
                        }
                        if (!timezone) {
                            ep.reply("User or timezone not found.");
                            return true;
                        }
                    }
                }
            } else {
                timezone = this.mod("Users").getMeta(handle, "timezone");
            }
            
            if (timezone) {
                let m = moment().tz(timezone);
                ep.reply(m.format('dddd YYYY-MM-DD HH:mm:ss (Z)') + (m.isDST() ? " [DST]" : ""));
            } else if (offset) {
                let m = moment().utcOffset(offset);
                ep.reply(m.format('dddd YYYY-MM-DD HH:mm:ss (Z)'));
            } else {
                ep.reply(moment().format('dddd YYYY-MM-DD HH:mm:ss') + " (server)");
            }
        
            return true;
        });


        this.mod("Commands").registerCommand(this, 'sametime', {
            description: "Lists channel users known to currently have the same time offset as you.",
            details: [
                "Use the distance argument to specify a tolerance in minutes (defaults to 0)."
            ],
            args: ["distance"],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let timezone = this.mod("Users").getMeta(handle, "timezone");
            if (!timezone) {
                ep.reply("Your timezone is not set.");
                return true;
            }

            let myinfo = ct.getTimezone(timezone);
            if (!myinfo) return true;

            let mymoment = moment().tz(timezone);

            let distance = parseInt(args.distance);
            if (isNaN(distance)) distance = 0;

            let results = [], also = 0;
            for (let targetid of env.listUserIds(channelid)) {
                if (userid == targetid) continue;
                let handles = this.mod("Users").getHandlesById(env.name, targetid);
                if (!handles.length) continue;
                let targetzone = this.mod("Users").getMeta(handles[0], "timezone");
                if (!targetzone) continue;
                let targetinfo = ct.getTimezone(targetzone);
                if (!targetinfo) continue;
                if (Math.abs(moment().tz(targetzone).utcOffset() - mymoment.utcOffset()) <= distance) {
                    results.push(env.idToDisplayName(targetid));
                }
            }

            if (results.length > MAX_SAME_USERS) {
                also = results.length - MAX_SAME_USERS;
                results = results.slice(0, MAX_SAME_USERS);
            }

            if (!results.length) {
                ep.reply("No users found.");
            } else {
                ep.reply(results.join(", ") + (also ? "and " + also + " other user" + (also != 1 ? "s" : "") : ""));
            }

            return true;
        });

      
        return true;
    };
    
    
    // # Module code below this line #
    
    


}


module.exports = ModTime;

