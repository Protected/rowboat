/* DiscordPing -- Tool for measuring latency between Rowboat and Discord. */

import moment from 'moment';

import Behavior from '../src/Behavior.js';

export default class DiscordPing extends Behavior {

    get params() { return [
        {n: 'delayBetween', d: "Delay between pings, not including rtt (ms)"},
        {n: 'maxDuration', d: "Maximum duration before autostop (ms)"},
        {n: 'scrollUp', d: "Amount of new messages in channel before autostop"}
    ]; }

    get defaults() { return {
        delayBetween: 2000,
        maxDuration: 3600000,
        scrollUp: 5
    }; }

    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('DiscordPing', name);

        this._anchor = null;
        this._startts = null;
        this._outts = null;
        
        this._stop = true;
        this._scrollCount = 0;
        
        this._count = null;
        this._errs = null;
        this._min = null;
        this._avg = null;
        this._max = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this.env("Discord").on('message', (env, type, message, authorid, channelid, rawobj) => {
            if (this._anchor && this._anchor.channelId == channelid) {
                this._scrollCount += 1;
            }
        }, this);
      
        //Register callbacks
        
        this.be('Commands').registerRootDetails(this, 'ping', {description: 'Measure latency between me and Discord using message edits.'});
        
        const permAdmin = this.be('Users').defaultPermAdmin;
        
        this.be('Commands').registerCommand(this, 'ping on', {
            description: "Start measuring ping on the current channel.",
            details: [
                "Ping can only be active in one channel at a time."
            ],
            permissions: [permAdmin],
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
            this._stop = false;
            this._scrollCount = 0;
            
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
            
                if (!this._anchor || this._stop || this._scrollCount >= this.param("scrollUp") || moment().valueOf() - this._startts > this.param('maxDuration')) {
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
        
        
        this.be('Commands').registerCommand(this, 'ping off', {
            description: "Stop measuring ping.",
            permissions: [permAdmin],
            environments: ['Discord']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._anchor) {
                ep.reply("Ping isn't running!");
                return true;
            }
            
            this._stop = true;
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'ping latest', {
            description: "Show latest stats.",
            permissions: [permAdmin],
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
