/* Module: Time -- Adds a time command and timezone tracking. */

const Module = require('../Module.js');

const moment = require('moment-timezone');
const ct = require('countries-and-timezones');

const MAX_SAME_USERS = 20;
const DEFAULT_FORMAT = "dddd Y-MM-DD HH:mm:ss (Z)";

class ModTime extends Module {

    get optionalParams() { return [
        'formats'               //Map of usable format string prefixes {NAME: FORMAT, ...}
    ]; }

    get requiredModules() { return [
        'Users',
        'Commands'
    ]; }

    constructor(name) {
        super('Time', name);

        this._params["formats"] = {  //No spaces in keys
            sane: "dddd Y-MM-DD HH:mm:ss (Z)",
            american: "dddd MMM D, Y hh:mm a (Z)",
            short: "ddd HH:mm:ss (Z)",
            iso8601: "Y-MM-DDTHH:mm:ssZ"
        }

        this._tzCallbacks = [];
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

            for (let func of this._tzCallbacks) {
                func(env, userid, handle, info);
            }

            ep.reply("Your timezone is now set to " + info.name + " (" + info.utcOffsetStr + ").");
        
            return true;
        });


        this.mod("Commands").registerCommand(this, 'tf', {
            description: "Change your clock format.",
            details: [
                "This will affect the output of !time when used by you only. The argument must be one of: " + Object.keys(this.param("formats")).join(", ") + ".",
                "Use '-' to unset your format override and return to the default."
            ],
            args: ["format"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!handle) {
                let user = this.mod("Users").getEnvUser(env.name, userid);
                if (!user) {
                    ep.reply("Unfortunately I couldn't create or retrieve your account. Please ask an administrator for manual assistance.");
                    return true;
                }
                handle = user.handle;
            }

            if (args.format == "-") {
                this.mod("Users").delMeta(handle, "timeformat");
                ep.reply("Clock format unset.");
                return true;
            }

            if (!this.param("formats")[args.format]) {
                ep.reply("Invalid format name. Please specify one of: " + Object.keys(this.param("formats")).join(", "));
                return true;
            }

            this.mod("Users").setMeta(handle, "timeformat", this.param("formats")[args.format]);
            ep.reply("Your clock format was changed.");

            return true;
        });


        this.mod("Commands").registerCommand(this, 'time', {
            description: "Retrieve the current time.",
            details: [
                "By default displays time in your timezone (if set) or in the server timezone.",
                "The argument can be:",
                "  '-' / 'default' / 'server': Force server time.",
                "  Any IANA (tz) timezone denomination: Use the given timezone (ex. Europe/London).",
                "  Offset: Use the given offset in relation to UTC (ex. -02:00).",
                "  USERNAME or =HANDLE: Use the timezone associated with a username or handle.",
                "Append <FORMAT to the end to change the format of the response (see `help tf` for more information)."
            ],
            args: ["timezone", true],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let format = this.mod("Users").getMeta(handle, "timeformat") || DEFAULT_FORMAT;

            if (args.timezone.length) {
                let extrf = args.timezone[args.timezone.length - 1].match(/<([a-z0-9-]+)/i);
                if (extrf) {
                    args.timezone.pop();
                    if (this.param("formats")[extrf[1]]) {
                        format = this.param("formats")[extrf[1]];
                    } else {
                        ep.reply("Invalid format name. Please specify one of: " + Object.keys(this.param("formats")).join(", "));
                        return true;
                    }
                }
            }

            let reqzone = args.timezone.join(" ");
            let parsed = this.parseTimezoneArgument(env, reqzone);

            if (parsed === false) {
                parsed = {timezone: this.mod("Users").getMeta(handle, "timezone")};
            } else if (parsed === null) {
                ep.reply("User or timezone not found.");
                return true;
            }

            if (parsed.timezone) {
                let m = moment().tz(parsed.timezone);
                ep.reply(m.format(format) + (m.isDST() ? " [DST]" : ""));
            } else if (parsed.offset) {
                let m = moment().utcOffset(parsed.offset);
                ep.reply(m.format(format));
            } else {
                ep.reply(moment().format(format.replace(/Z/, "[*-server-*]")));
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


        this.mod("Commands").registerCommand(this, 'timediff', {
            description: "Shows the current difference between your timezone and another.",
            details: [
                "The argument can be:",
                "  '-' / 'default' / 'server': Use server time.",
                "  Any IANA (tz) timezone denomination: Use the given timezone (ex. Europe/London).",
                "  Offset: Use the given offset in relation to UTC (ex. -02:00).",
                "  USERNAME or =HANDLE: Use the timezone associated with a username or handle."
            ],
            args: ["timezone", true],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let timezone = this.mod("Users").getMeta(handle, "timezone");
            if (!timezone) {
                ep.reply("Your timezone is not set.");
                return true;
            }

            let reqzone = args.timezone.join(" ");
            let parsed = this.parseTimezoneArgument(env, reqzone);

            if (parsed === false) {
                parsed = {timezone: null, offset: null, owner: "*-server-*"};
            } else if (parsed === null) {
                ep.reply("User or timezone not found.");
                return true;
            }

            let reqoffset, myoffset = moment().tz(timezone).utcOffset();
            let reqdst, mydst = moment().tz(timezone).isDST();
            if (parsed.timezone) {
                reqoffset = moment().tz(parsed.timezone).utcOffset();
                reqdst = moment().tz(parsed.timezone).isDST();
            } else if (parsed.offset) {
                reqoffset = moment().utcOffset(parsed.offset).utcOffset();
                reqdst = false;
            } else {
                reqoffset = moment().utcOffset();
                reqdst = moment().isDST();
            }

            let diff = reqoffset - myoffset;
            if (diff == 0) {
                ep.reply(parsed.owner + (reqdst ? " [DST]" : "") + " currently has the same clock time as you!");
            } else {
                let explain;
                if (diff > 0) explain = "It's later there!";
                else explain = "It's earlier there!";
                ep.reply(parsed.owner + (reqdst ? " [DST]" : "") + " is " + moment().utcOffset(diff).format("Z") + " offset from you. " + explain);
            }

            return true;
        });

      
        return true;
    };
    
    
    // # Module code below this line #

    
    //Helpers

    parseTimezoneArgument(env, reqzone) {
        if (!env || !reqzone) return false;  //Empty arguments

        let timezone = null;
        let offset = null;
        let owner = "*-server-*";  //Use only for display purposes

        if (!reqzone.match(/^-|default|server$/i)) {
            let info = ct.getTimezone(reqzone);
            if (info) {
                timezone = info.name;
                owner = timezone;
            } else if (reqzone.match(/^[+-][01][0-9]:[0-9]{2}$/)) {
                offset = reqzone;
                owner = offset;
            } else {
                let checkhandle = reqzone.match(/^=(.*)$/);
                if (checkhandle) {
                    timezone = this.mod("Users").getMeta(checkhandle[1], "timezone");
                    owner = checkhandle[1];
                } else {
                    let handles = this.mod("Users").getHandlesById(env.name, env.displayNameToId(reqzone) || reqzone);
                    if (handles.length) {
                        timezone = this.mod("Users").getMeta(handles[0], "timezone");
                        owner = reqzone;
                    }
                }
                if (!timezone) return null;  //Invalid request
            }
        }

        return {timezone: timezone, offset: offset, owner: owner};  //If both are empty, use server time
    }


    //Register callbacks to be invoked when a user sets their timezone. Signature: (env, userid, handle, tzinfo)

    registerTimezoneCallback(func) {
        this._tzCallbacks.push(func);
    }


    //Return tz timezone names

    getTimezoneByUserid(env, userid) {
        let handles = this.mod("Users").getHandlesById(env.name, userid);
        if (!handles.length) return null;
        return this.getTimezoneByHandle(handles[0]);
    }

    getTimezoneByHandle(handle) {
        return this.mod("Users").getMeta(handle, "timezone");
    }

    //Return offset in minutes

    getCurrentUtcOffsetByUserid(env, userid) {
        let timezone = this.getTimezoneByUserid(env, userid);
        if (!timezone) return null;
        return moment().tz(timezone).utcOffset();
    }

    getCurrentUtcOffsetByHandle(handle) {
        let timezone = this.getTimezoneByHandle(handle);
        if (!timezone) return null;
        return moment().tz(timezone).utcOffset();
    }

    //Return moment.js instances

    getCurrentMomentByUserid(env, userid) {
        let timezone = this.getTimezoneByUserid(env, userid);
        if (!timezone) return null;
        return moment().tz(timezone);
    }

    getCurrentMomentByHandle(handle) {
        let timezone = this.getTimezoneByHandle(handle);
        if (!timezone) return null;
        return moment().tz(timezone);
    }


}


module.exports = ModTime;

