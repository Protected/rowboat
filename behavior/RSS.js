import moment from 'moment';
import FeedParser from 'feedparser';
import striptags from 'striptags';

var EmbedBuilder;
try {
    EmbedBuilder = await import('discord.js').then(ns => ns.EmbedBuilder);
} catch (err) {}

import Behavior from '../src/Behavior.js';

const RESULT_SUCCESS = "success";
const RESULT_SERVERERR = "servererr"
const RESULT_NOTFOUND = "notfound";
const RESULT_ERROR = "error";
const RESULT_INVALID = "invalidfeed";

export default class RSS extends Behavior {

    get description() { return "Keep track of RSS/Atom feeds"; }

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        {n: 'envs', d: "List of allowed environments, or null for all"},
        {n: 'minfrequency', d: "Minimum update frequency (s)"},
        {n: 'frequency', d: "Default update frequency (s)"},
        {n: 'timer', d: "Timer interval (s)"},
        {n: 'timeout', d: "Timeout for HTTP requests (ms)"},
        {n: 'timestampformat', d: "Display format for timestamps"},
        {n: 'richembed', d: "Whether to use embeds in Discord environments"},
        {n: 'color', d: "Default color hint for feeds in Discord embeds ([R, G, B])"}
    ]; }

    get defaults() { return {
        datafile: null,
        envs: null,
        minfrequency: 30,
        frequency: 300,
        timer: 15,
        timeout: 5000,
        timestampformat: "YYYY-MM-DD HH:mm",
        richembed: false,
        color: [0, 30, 120]
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('RSS', name);
        
        this._envProxy = null;

        //{feed: {name, url, frequency, env, channelid, creatorid, latest, latestresult, data: [entries, ...]}}
        this._data = {};

        //{feed: {id: entry, ...}}
        this._index = {};

        this._timer = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        this._envProxy = opt.envProxy;

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
        
        const permAdmin = this.be('Users').defaultPermAdmin;

        this.be('Commands').registerRootDetails(this, 'rss', {description: 'Control RSS feeds.'});


        let create = (announce) => (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (this._data[feedid]) {
                ep.reply("There already exists a feed with this name.");
                return true;
            }

            let announcechannel = null;
            if (announce) {
                if (env.channelIdToType(channelid) != "regular") {
                    ep.reply("This command can only be used in a public channel.");
                    return true;
                }
                announcechannel = channelid;
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
                        channelid: announcechannel,
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
        };
        
        this.be('Commands').registerCommand(this, 'rss create', {
            description: "Register a new RSS feed.",
            args: ["url", "name", true],
            permissions: [permAdmin]
        }, create(false));

        this.be('Commands').registerCommand(this, 'rss createhere', {
            description: "Register a new RSS feed that announces to the current channel.",
            args: ["url", "name", true],
            permissions: [permAdmin]
        }, create(true));


        this.be('Commands').registerCommand(this, 'rss destroy', {
            description: "Destroy an RSS feed. All saved data will be lost.",
            args: ["name", true],
            permissions: [permAdmin]
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


        this.be('Commands').registerCommand(this, 'rss set name', {
            description: "Rename an existing RSS feed.",
            args: ["name", "newname"],
            permissions: [permAdmin]
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


        this.be('Commands').registerCommand(this, 'rss set url', {
            description: "Change the URL of an existing RSS feed.",
            args: ["name", "url"],
            permissions: [permAdmin]
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


        this.be('Commands').registerCommand(this, 'rss set frequency', {
            description: "Set an update frequency for an RSS feed, overriding the default.",
            details: ["If the frequency argument is not provided, the feed will be reassigned to the default frequency."],
            args: ["name", "frequency"],
            minArgs: 1,
            permissions: [permAdmin]
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


        this.be('Commands').registerCommand(this, 'rss set channel', {
            description: "Set a channel to which feed updates are automatically sent.",
            details: ["If the channel argument is not provided, updates will no longer be sent to any channel."],
            args: ["name", "channelid"],
            minArgs: 1,
            permissions: [permAdmin]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.split(" ").join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            if (args.channelid) {

                let feedenv = this._envProxy(this._data[feedid].env);
                if (!feedenv) {
                    ep.reply("This feed's environment is currently unavailable, so the announcement channel can't be set.");
                    return true;
                }

                let channelid = args.channelid;
                if (feedenv.type == "Discord") {
                    channelid = feedenv.extractChannelId(channelid);
                }

                let channeltype = await feedenv.channelIdToType(channelid);
                if (channeltype != "regular") {
                    ep.reply("Please provide the valid ID of a public channel.");
                    return true;
                }

                this._data[feedid].channelid = channelid;
                ep.reply("Announcement channel for feed updates successfully set.");

            } else {
                this._data[feedid].channelid = null;
                ep.reply("Cleared announcement channel for feed updates.")
            }

            this._data.save();
        
            return true;
        });


        this.be('Commands').registerCommand(this, 'rss set color', {
            description: "Set a color hint for displaying updates in supported environment types.",
            args: ["name", "red", "green", "blue"],
            minArgs: 1,
            permissions: [permAdmin]
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


        this.be('Commands').registerCommand(this, 'rss list', {
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


        this.be('Commands').registerCommand(this, 'rss info', {
            description: "Displays information on an RSS feed.",
            args: ["name", true]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let feedid = args.name.join("").toLowerCase();
            if (!this._data[feedid]) {
                ep.reply("Feed not found.");
                return true;
            }

            let feed = this._data[feedid];
            let feedenv = this._envProxy(feed.env);
            let msg;

            if (env.type == "Discord" && this.param("richembed")) {
                msg = new EmbedBuilder();

                msg.setColor(feed.color || this.param("color"));
                msg.setTitle(feed.name);
                msg.setURL(feed.url);

                msg.addFields(
                    {name: "Update frequency (s)", value: feed.frequency || this.param("frequency")},
                    {name: "Environment", value: feed.env},
                    {name: "Creator", value: feedenv ? await feedenv.idToDisplayName(feed.creatorid) : feed.creatorid}
                );
                if (feed.channelid) {
                    msg.addFields({name: "Announce channel", value: feedenv ? await feedenv.channelIdToDisplayName(feed.channelid) : feed.channelid});
                }
                if (feed.latest) {
                    msg.addFields(
                        {name: "Latest sync", value: moment(feed.latest * 1000).fromNow() + " (" + feed.latestresult + ")"},
                        {name: "Seen entries", value: feed.data.length}
                    );
                }

            } else {

                msg = "**" + feed.name + "** - " + feed.url + "\n";
                msg += "Update frequency (s): " + (feed.frequency || this.param("frequency")) + "\n";
                msg += "Environment: " + feed.env + "\n";
                msg += "Creator: " + (feedenv ? await feedenv.idToDisplayName(feed.creatorid) : feed.creatorid) + "\n";
                if (feed.channelid) {
                    msg += "Announce channel: " + (feedenv ? await feedenv.channelIdToDisplayName(feed.channelid) : feed.channelid) + "\n";
                }
                if (feed.latest) {
                    msg += "Latest sync: " + (moment(feed.latest * 1000).fromNow() + " (" + feed.latestresult + ")") + "\n";
                    msg += "Seen entries: " + feed.data.length + "\n";
                }

            }

            ep.reply(msg);
        
            return true;
        });


        this.be('Commands').registerCommand(this, 'rss update', {
            description: "Attempt to sync a feed immediately.",
            args: ["name", true],
            permissions: [permAdmin]
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

        this.be('Commands').registerCommand(this, 'rss check', {
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
            this.streamget(url, {method: 'HEAD', timeout: this.param("timeout")}, (res) => {
                if (/4\d\d/.test(res.statusCode)) reject({problem: RESULT_NOTFOUND});
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
                this.updateFeed(feedid)
                    .catch((problem) => {});
            }
        }
    }


    updateFeed(feedid) {
        let feed = this._data[feedid];
        let env = this._envProxy(feed.env);

        return new Promise((resolve, reject) => {
            let req = this.streamget(feed.url, {timeout: this.param("timeout")});
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
                (async () => {
                    if (received.length) {
                        let bootstrap = !feed.data.length;

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
            
                            if (env && feed.channelid && !bootstrap) {
                                await this.outputFeedEntry(env, feed.channelid, feed, entry);
                            }
                        }
                    }

                    feed.latest = moment().unix();
                    feed.latestresult = RESULT_SUCCESS;
                    this._data.save();

                    resolve(received);
                })();
            });

        });
    }


    rssPubDate(datestr) {
        return moment(datestr, ['ddd, DD MMM YYYY HH:mm:ss ZZ', 'ddd, DD MMM YY HH:mm:ss ZZ', 'YYYY-MM-DDTHH:mm:ss.SSSZ']); 
    }


    async outputFeedEntry(env, channelid, feed, entry) {
        let msg;

        let channeltype = await env.channelIdToType(channelid);
        if (channeltype != "regular") return false;

        if (env.type == "Discord" && this.param("richembed")) {

            msg = new EmbedBuilder();
            msg.setColor(feed.color || this.param("color"));
            msg.setTitle(entry.title);
            msg.setAuthor({name: feed.name});
            msg.setURL(entry.link);

            if (entry.pubDate) {
                msg.setTimestamp(this.rssPubDate(entry.pubDate).toDate());
            }
            
            if (entry.description) {
                let imgcheck = entry.description.match(/<img[^>]+src="([^"]+)"/);
                if (imgcheck) {
                    let imgurl = imgcheck[1];
                    if (imgurl.match(/^\/\//)) {
                        let wrappercheck = feed.url.match(/^([^:]+:)/);
                        imgurl = wrappercheck[1] + imgurl;
                    } else if (imgurl.match(/^\//)) {
                        let basecheck = feed.url.match(/^([a-z0-9]+:\/\/[^/]+)\//i);
                        imgurl = basecheck[1] + imgurl;
                    }
                    msg.setImage(imgurl);
                }

                let description = striptags(entry.description.split("\n").map((item) => item.trim()).join("\n").replace(/\n+/g, "\n"), [], " ");
                if (description.length > 2048) {
                    description = description.substr(0, 2044) + "...";
                }
                if (description) {
                    msg.setDescription(description);
                }
            }

            if (entry.author) {
                msg.setFooter({text: entry.author});
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
