/* Module: Whois -- Adds a command, "netwhois", which retrieves information on a registered internet resource. */

const Module = require('./Module.js');
const whois = require('whois');
const moment = require('moment');

const TSFORMAT = "YYYY-MM-DD HH:mm:ss";

class ModWhois extends Module {


    get optionalParams() { return [
        'server',               //Use a specific whois server ("host:port"); leave blank to determine by TLD
        'follow',               //Amount of times to follow redirects
        'timeout',              //Socket timeout (ms)
        'bind',                 //Bind to a specific local interface (IP)
        'expire'                //Timeout to expire cached results (s)
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Whois', name);

        this._params['server'] = "";
        this._params['follow'] = 2;
        this._params['timeout'] = 10000;
        this._params['bind'] = null;
        this._params['expire'] = 1800;

        this._cache = {};  //{data: ..., ts: ...}
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.mod('Commands').registerCommand(this, 'netwhois', {
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
                    if (env.envName == "Discord") display = "```\n" + display + "\n```";
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


module.exports = ModWhois;

