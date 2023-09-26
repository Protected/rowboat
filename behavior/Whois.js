/* Whois -- Adds a command, "netwhois", which retrieves information on a registered internet resource. */

import whois from 'whois';
import moment from 'moment';

import Behavior from '../src/Behavior.js';

const TSFORMAT = "YYYY-MM-DD HH:mm:ss";

export default class Whois extends Behavior {

    get params() { return [
        {n: 'server', d: "Use a specific whois server; leave blank to determine by TLD (host:port)"},
        {n: 'follow', d: "Amount of times to follow redirects"},
        {n: 'timeout', d: "Socket timeout (ms)"},
        {n: 'bind', d: "Bind to a specific local interface (IP)"},
        {n: 'expire', d: "Timeout to expire cached results (s)"}
    ]; }

    get defaults() { return {
        server: "",
        follow: 2,
        timeout: 10000,
        bind: null,
        expire: 1800
    }; }

    get requiredBehaviors() { return {
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('Whois', name);

        this._cache = {};  //{data: ..., ts: ...}
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.be('Commands').registerCommand(this, 'netwhois', {
            description: "Queries a WHOIS server.",
            args: ["string"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            this.lookup(args.string)

                .then((result) => {
                    let display = ""
                    let excerpt = false;
                    if (type == "private") {
                        display = result.data;
                    } else {

                        //Remove comments
                        let prelines = [];
                        for (let line of result.data.split("\n")) {
                            if (!line.match(/^%/)) {
                                prelines.push(line);
                            }
                        }

                        //Crop message by characters and lines
                        display = prelines.join("\n").substr(0, 2000);

                        let lines = display.split("\n");
                        if (display.length != result.data.length) {
                            lines = lines.slice(0, lines.length - 1);
                        }
                        if (lines.length > 20) {
                            lines = lines.slice(0, 20);
                        }

                        display = lines.join("\n").trim();
                        if (display.length != result.data.length) {
                            excerpt = true;
                        }
                    }

                    ep.reply("**WHOIS lookup " + (excerpt ? "excerpt" : "result") + " for __" + args.string + "__** (" + moment.unix(result.ts).format(TSFORMAT) + ")");
                    if (env.type == "Discord") display = "```\n" + display + "\n```";
                    ep.reply(display);

                    this.log('Successful whois lookup for "' + args.string + '" (Requested by ' + userid + ')');
                })

                .catch((err) => {
                    ep.reply("Lookup failed: " + err.code + (err.host ? " (Host: " + err.host + ")" : ""));
                    this.log('Failed whois lookup for "' + args.string + '": ' + err + ' (Requested by ' + userid + ')');
                });
        
            return true;
        });
      
        return true;
    };


    lookup(query) {
        let now = moment().unix();

        if (this._cache[query]) {
            if (this._cache[query].ts < now - this.param('expire')) {
                delete this._cache[query];
            } else {
                return Promise.resolve(this._cache[query]);
            }
        }

        return new Promise((resolve, reject) => {

            whois.lookup(query, {
                server: this.param('server'),
                follow: this.param('follow'),
                timeout: this.param('timeout'),
                verbose: false,
                bind: this.param('bind')
            }, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    this._cache[query] = {data: data, ts: now};
                    resolve(this._cache[query]);
                }
            });

        });
    }


}
