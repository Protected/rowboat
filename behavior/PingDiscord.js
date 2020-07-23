/* Module: PingDiscord -- Tool for measuring latency between Rowboat and Discord. */

const Module = require('../Module.js');
const moment = require('moment');

const PERM_ADMIN = "administrator";

class ModPingDiscord extends Module {

    get optionalParams() { return [
        'delayBetween',         //Delay between pings, not including rtt
        'maxDuration',          //Duration before autostop
        'scrollUp'              //Amount of new messages in channel before autostop
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('PingDiscord', name);
        
        this._params['delayBetween'] = 2000;  //ms
        this._params['maxDuration'] = 3600000;  //ms
        
        this._anchor = null;
        this._startts = null;
        this._outts = null;
        
        this._count = null;
        this._errs = null;
        this._min = null;
        this._avg = null;
        this._max = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerRootDetails(this, 'ping', {description: 'Measure latency between me and Discord.'});
        
        
        this.mod('Commands').registerCommand(this, 'ping on', {
            description: "Start measuring ping on the current channel.",
            details: [
                "Ping can only be active in one channel at a time."
            ],
            permissions: [PERM_ADMIN],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._anchor) {
                ep.reply("Ping is already running.");
                return true;
            }
            
            this._count = 0;
            this._errs = 0;
            this._min = null;
            this._avg = null;
            this._max = null;
            
            let channel = env.server.channels.cache.get(channelid);
            
            //Receive message. Update stats. Call next().
            let pinger = (message) => {
                if (!this._anchor) {
                    this._anchor.edit("`STOPPED " + this.statString() + "`");
                    return;
                }
                
                let delay = moment().valueOf() - this._outts;
                
                this._count += 1;
                if (this._min === null || delay < this._min) this._min = delay;
                if (this._max === null || delay > this._max) this._max = delay;
                if (this._avg === null) {
                    this._avg = delay;
                } else {
                    this._avg = Math.round(1.0 * (this._avg * (this._count - 1) + delay) / this._count);
                }
                
                next(message);
            };
            
            //Emits next message and calls pinger() or retries in case of error.
            let next = (message) => {
            
                if (!this._anchor || moment().valueOf() - this._startts > this.param('maxDuration')) {
                    if (this._anchor) this._anchor.edit("`STOPPED " + this.statString() + "`");
                    this._anchor = null;
                    return;
                }
                
                setTimeout(() => {
                    this._outts = moment().valueOf();
                    message.edit("`RUNNING " + this.statString() + "`")
                        .then(pinger)
                        .catch(() => {
                            this._errs += 1;
                            next(message);
                        });
                }, this.param('delayBetween'));
            };
            
            //Kickstart the pinger.
            this._startts = this._outts = moment().valueOf();
            channel.send("Starting ping...").then((message) => {
                this._anchor = message;
                pinger(message);
            });
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'ping off', {
            description: "Stop measuring ping.",
            permissions: [PERM_ADMIN],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._anchor) {
                ep.reply("Ping isn't running!");
                return true;
            }
            
            this._anchor.edit("`STOPPED " + this.statString() + "`");
            
            this._anchor = null;
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'ping latest', {
            description: "Show latest stats.",
            permissions: [PERM_ADMIN],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._outts) {
                ep.reply("No information has been collected yet.");
                return true;
            }
            
            ep.reply(moment(this._outts).format("Y-MM-DD HH:mm:ss") + " `" + this.statString() + "`");
        
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    statString() {
        return "#" + (this._count + this._errs) + " Min:" + this._min + " Avg:" + this._avg + " Max:" + this._max + " Err#:" + this._errs + " Err%:" + Math.round(1.0 * this._errs / (this._count + this._errs));
    }

}


module.exports = ModPingDiscord;
