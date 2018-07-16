/* Module: RSS -- Keep track of RSS feeds. */

const Module = require('./Module.js');
const moment = require('moment');
const request = require('request');
const FeedParser = require('feedparser');
const striptags = require('striptags');

try {
    var discord = require('discord.js');
} catch (err) {}

const RESULT_SUCCESS = "success";
const RESULT_SERVERERR = "servererr"
const RESULT_NOTFOUND = "notfound";
const RESULT_ERROR = "error";
const RESULT_INVALID = "invalidfeed";

const PERM_ADMIN = "administrator";


class ModRSS extends Module {

    get optionalParams() { return [
        'datafile',
        'envs',                 //List of allowed environments, or null for all
        'minfrequency',         //Minimum update frequency (s)
        'frequency',            //Default update frequency (s)
        'timer',                //Timer interval (s)
        'timeout',              //Timeout for HTTP requests (ms)
        'timestampformat',      //Display format for timestamps
        'color'                 //Default color hint for feeds (Discord only)
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('RSS', name);
        
        this._params['datafile'] = null;
        this._params['envs'] = null;
        this._params['minfrequency'] = 30;
        this._params['frequency'] = 300;
        this._params['timer'] = 15;
        this._params['timeout'] = 5000;
        this._params['timestampformat'] = "YYYY-MM-DD HH:mm";
        this._params['color'] = [0, 30, 120];

        //{feed: {name, url, frequency, env, channelid, creatorid, latest, latestresult, data: [entries, ...]}}
        this._data = {};

        //{feed: {id: entry, ...}}
        this._index = {};

        this._timer = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._data = this.loadData(null, {}, {quiet: true});
        if (this._data === false) return false;

        //Create entry index

        for (let feed in this._data) {
            this._index[feed] = {};
            for (let entry of this._data[feed].data) {
                let id = this.rssId(entry);
                if (!id) continue;
                this._index[feed][id] = entry;
            }
        }

        //Start update timer

        var self = this;
        this._timer = setInterval(() => {
            self.updateFeeds();
        }, this.param("timer") * 1000);

      
        //Register callbacks
        
        this.mod('Commands').registerRootDetails(this, 'rss', {description: 'Control RSS feeds.'});
        
        
        this.mod('Commands').registerCommand(this, 'rss create', {
            description: "Register a new RSS feed.",
            args: ["url", "name", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (this._data[feedid]) {
                ep.reply("There already exists a feed with this name.");
                return true;
            }

            this.urlExists(args.url)
                .catch((reason) => {
                    ep.reply("Unable to open RSS feed URL. Reason:" + reason.problem);
                })
                .then(() => {
                    this._data[feedid] = {
                        name: args.name.join(" "),
                        url: args.url,
                        frequency: null,
                        color: null,
                        env: env.name,
                        channelid: null,
                        creatorid: userid,
                        latest: null,
                        latestresult: null,
                        data: []
                    };
                    this._data.save();
                    this._index[feedid] = {};
                    ep.reply("Feed created.");
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss destroy', {
            description: "Destroy an RSS feed. All saved data will be lost.",
            args: ["name", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            delete this._data[feedid];
            this._data.save();
            if (this._index[feedid]) {
                delete this._index[feedid];
            }

            ep.reply("Feed destroyed.");
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss set name', {
            description: "Rename an existing RSS feed.",
            args: ["name", "newname"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }
            
            let newfeedid = args.newname.split(" ").join("").toLowerCase();
            if (this._data[newfeedid]) {
                ep.reply("There already is a feed with the new name.");
                return true;
            }

            this._data[newfeedid] = this._data[feedid];
            this._data[newfeedid].name = args.newname;
            delete this._data[feedid];
            this._data.save();

            this._index[newfeedid] = this._index[feedid];
            delete this._index[feedid];

            ep.reply("Feed renamed.");
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss set url', {
            description: "Change the URL of an existing RSS feed.",
            args: ["name", "url"],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            this.urlExists(args.url)
                .catch((reason) => {
                    ep.reply("Unable to open new RSS feed URL. Reason:" + reason.problem);
                })
                .then(() => {
                    this._data[feedid].url = args.url;
                    this._data.save();
                    ep.reply("Feed URL updated.");
                });
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss set frequency', {
            description: "Set an update frequency for an RSS feed, overriding the default.",
            details: ["If the frequency argument is not provided, the feed will be reassigned to the default frequency."],
            args: ["name", "frequency"],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            if (args.frequency) {
                this._data[feedid].frequency = Math.max(args.frequency, this.param("minfrequency"));
                ep.reply("Feed update frequency set to " + this._data[feedid].frequency + "s.");
            } else {
                this._data[feedid].frequency = null;
                ep.reply("Feed update frequency set to default (" + this.param("frequency") + "s).");
            }

            this._data.save();
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss set channelid', {
            description: "Set a channel to which feed updates are automatically sent.",
            details: ["If the channel argument is not provided, updates will no longer be sent to any channel."],
            args: ["name", "channelid"],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            if (args.channelid) {
                
                let feedenv = this.env(this._data[feedid].env);
                if (!feedenv) {
                    ep.reply("This feed's environment is currently unavailable, so the announcement channel can't be set.");
                    return true;
                }

                let channeltype = feedenv.channelIdToType(args.channelid);
                if (channeltype != "regular") {
                    ep.reply("Please provide the valid ID of a public channel.");
                    return true;
                }

                this._data[feedid].channelid = args.channelid;
                ep.reply("Announcement channel for feed updates successfully set.");

            } else {
                this._data[feedid].channelid = null;
                ep.reply("Cleared announcement channel for feed updates.")
            }

            this._data.save();
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss set color', {
            description: "Set a color hint for displaying updates in supported environment types.",
            args: ["name", "red", "green", "blue"],
            minArgs: 1,
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            if (args.red && args.green && args.blue) {

                let red = parseInt(args.red);
                let green = parseInt(args.green);
                let blue = parseInt(args.blue);
                
                if (red < 0 || red > 255 || green < 0 || green > 255 || blue < 0 || blue > 255) {
                    ep.reply("The red, green and blue components of the hint color must be numbers from 0 to 255.");
                }

                this._data[feedid].color = [red, green, blue];
                ep.reply("Color hint for feed updates successfully set.");

            } else {
                this._data[feedid].color = null;
                ep.reply("Cleared color hint for feed updates.")
            }

            this._data.save();
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss list', {
            description: "Lists existing RSS feeds.",
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedlist = Object.keys(this._data).map((feedid) => this._data[feedid].name);
            if (!feedlist.length) {
                ep.reply("There are no RSS feeds.");
            } else {
                for (let feedname of feedlist) {
                    ep.reply(feedname);
                }
            }
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss info', {
            description: "Displays information on an RSS feed.",
            args: ["name", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            let feed = this._data[feedid];
            let feedenv = this.env(feed.env);
            let msg;

            if (env.envName == "Discord") {
                msg = new discord.RichEmbed();

                msg.setColor(feed.color || this.param("color"));
                msg.setTitle(feed.name);
                msg.setURL(feed.url);

                msg.addField("Update frequency (s)", feed.frequency || this.param("frequency"));
                msg.addField("Environment", feed.env);
                msg.addField("Creator", feedenv ? feedenv.idToDisplayName(feed.creatorid) : feed.creatorid);
                if (feed.channelid) {
                    msg.addField("Announce channel", feedenv ? feedenv.channelIdToDisplayName(feed.channelid) : feed.channelid);
                }
                if (feed.latest) {
                    msg.addField("Latest sync", moment(feed.latest * 1000).fromNow() + " (" + feed.latestresult + ")");
                    msg.addField("Seen entries", feed.data.length);
                }

            } else {



            }

            ep.reply(msg);
        
            return true;
        });


        this.mod('Commands').registerCommand(this, 'rss update', {
            description: "Attempt to sync a feed immediately.",
            args: ["name", true],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let feedid = args.name.join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            this.updateFeed(feedid)
                .then((results) => {
                    let respart = "";
                    if (results && results.length) {
                        respart = results.length + " new entr" + (results.length == 1 ? "y" : "ies") + ".";
                    }
                    ep.reply("Feed synced successfully. " + respart);
                })
                .catch((problem) => {
                    ep.reply("Failed to sync feed: " + problem);
                });

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rss check', {
            description: "Shows the latest entry in a feed.",
            args: ["name", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            if (!this._data[feedid].data.length) {
                ep.reply("Feed is empty.");
                return true;
            }

            this.outputFeedEntry(env, channelid, this._data[feedid], this._data[feedid].data[this._data[feedid].data.length - 1]);
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    rssId(entry) {
        return entry.guid || entry.id || entry.title.toLowerCase().replace(/ /g, "");
    }



    urlExists(url) {
        return new Promise((resolve, reject) => {
            request({url: url, method: 'HEAD', timeout: this.param("timeout")}, (err, res) => {
                if (err) reject({problem: RESULT_ERROR, error: err});
                else if (/4\d\d/.test(res.statusCode)) reject({problem: RESULT_NOTFOUND});
                else if (/5\d\d/.test(res.statusCode)) reject({problem: RESULT_SERVERERR});
                else resolve();
            });
        });
    }


    updateFeeds() {
        let now = moment().unix();
        for (let feedid of Object.keys(this._data)) {
            let feed = this._data[feedid];
            let frequency = feed.frequency || this.param("frequency");
            if (!feed.latest || feed.latestresult != RESULT_SUCCESS || feed.latest + frequency <= now) {
                this.updateFeed(feedid);
            }
        }
    }


    updateFeed(feedid) {
        let feed = this._data[feedid];
        let env = this.env(feed.env);

        return new Promise((resolve, reject) => {
            let req = request({url: feed.url, timeout: this.param("timeout")});
            let parser = new FeedParser({feedurl: feed.url, addmeta: false});

            req.on("error", (err) => {
                this.log("warn", "Problem updating feed '" + feedid + "': " + RESULT_ERROR + " (" + err + ")");

                feed.latest = moment().unix();
                feed.latestresult = RESULT_ERROR;
                this._data.save();

                reject(RESULT_ERROR);
            });

            req.on("response", (res) => {
                let problem = null;
                if (/4\d\d/.test(res.statusCode)) problem = RESULT_NOTFOUND;
                else if (/5\d\d/.test(res.statusCode)) problem = RESULT_SERVERERR;
                if (problem) {
                    this.log("warn", "Problem updating feed '" + feedid + "': " + problem);

                    feed.latest = moment().unix();
                    feed.latestresult = problem;
                    this._data.save();

                    reject(problem.problem);
                } else {
                    req.pipe(parser);
                }
            });

            parser.on("error", (error) => {
                this.log("warn", "Problem updating feed '" + feedid + "': " + RESULT_INVALID);

                feed.latest = moment().unix();
                feed.latestresult = RESULT_INVALID;
                this._data.save();

                reject(RESULT_INVALID);
            });

            let received = [];

            parser.on("data", (entry) => {
                let id = this.rssId(entry);
                if (!id || this._index[feedid][id]) return;

                received.push(entry);
            });
            
            parser.on("end", () => {
                if (received.length) {
                    received.reverse();

                    if (received[0].pubDate) {
                        received.sort((a, b) => {
                            if (this.rssPubDate(a.pubDate).isAfter(this.rssPubDate(b.pubDate))) return 1;
                            return -1;
                        });
                    }

                    for (let entry of received) {
                        feed.data.push(entry);
                        this._index[feedid][this.rssId(entry)] = entry;
        
                        if (env && feed.channelid) {
                            this.outputFeedEntry(env, feed.channelid, feed, entry);
                        }
                    }
                }

                this.log("Feed '" + feedid + "' updated successfully.");

                feed.latest = moment().unix();
                feed.latestresult = RESULT_SUCCESS;
                this._data.save();

                resolve(received);
            });

        });
    }


    rssPubDate(datestr) {
        return moment(datestr, ['ddd, DD MMM YYYY HH:mm:ss ZZ', 'ddd, DD MMM YY HH:mm:ss ZZ', 'YYYY-MM-DDTHH:mm:ss.SSSZ']); 
    }


    outputFeedEntry(env, channelid, feed, entry) {
        let msg;

        let channeltype = env.channelIdToType(channelid);
        if (channeltype != "regular") return false;

        if (env.envName == "Discord") {

            msg = new discord.RichEmbed();
            msg.setColor(feed.color || this.param("color"));
            msg.setTitle(entry.title);
            msg.setAuthor(feed.name);
            msg.setURL(entry.link);

            if (entry.pubDate) {
                msg.setTimestamp(this.rssPubDate(entry.pubDate).toDate());
            }
            
            let imgcheck = entry.description.match(/<img[^>]+src="([^"]+)"/);
            if (imgcheck) {
                msg.setImage(imgcheck[1]);
            }

            msg.setDescription(striptags(entry.description.split("\n").map((item) => item.trim()).join("\n").replace(/\n+/g, "\n"), [], " "));

            if (entry.author) {
                msg.setFooter(entry.author);
            }            

        } else {

            msg = "[" + feed.name + "] **" + entry.title + "**";
            if (entry.pubDate) {
                msg += " (" + this.rssPubDate(entry.pubDate).format(this.param("timestampformat")) + ")";
            }
            msg += ": " + entry.link;

        }

        env.msg(channelid, msg);
        return true;
    }

}


module.exports = ModRSS;
