import fs from 'fs';
import moment from 'moment';
import jsonfile from 'jsonfile';
import jszip from 'jszip';
import { AttachmentBuilder, MessageType } from 'discord.js';

import Behavior from '../src/Behavior.js';

const RCDV_PATH = 'extra/discordchanneldownload/rcdv.html';

export default class DiscordChannelDownload extends Behavior {

    get description() { return "Search or download channel data"; }

    get params() { return [
        {n: 'cachePath', d: "Subdirectory for cached channel dumps"},
        {n: 'scanDelay', d: "Delay between attempts to download messages (ms)"},
        {n: 'cacheTolerance', d: "How long before a cached scan becomes stale (s)"},
        {n: 'updateDelay', d: "How often to apply updates to cached dumps (s)"},
        {n: 'permissions', d: "List of bot permission templates for filtering allowed text channels; expands %env%, %parentid% and %channelid% (or true for all channels)"}
    ]; }

    get defaults() { return {
        cachePath: "dcache",
        scanDelay: 250,
        cacheTolerance: 3600,
        updateDelay: 900,
        permissions: ['download_%channelid%']
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    get denv() {
        return this.env('Discord');
    }

    constructor(name) {
        super('DiscordChannelDownload', name);

        this._scanQueue = [];  //Rate limited queue. Each item is an anonymous function that scans channel messages.
        this._scanTimer = null;

        this._latestCached = {};  //{CHANNELID: TS, ...} Keeps timestamps of creation of cached requests to minimize file access
                                //Changes before this timestamp must go in _dirty. If the timestamp is null, there is no cache.
        this._dirty = {};  //{CHANNELID: {MESSAGEID: {text, ts}, ...}, ...} Pending cache updates
        this._updateTimer = null;
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        //# Create cache path
        
        if (!fs.existsSync(this.dataPath() + this.param("cachePath"))) {
            fs.mkdirSync(this.dataPath() + this.param("cachePath"), {recursive: true});
        }

        //# Timers
        
        var self = this;
        
        this._scanTimer = setInterval(() => {
            self.dequeueAndScan.apply(self, null);
        }, this.param('scanDelay'));

        this._updateTimer = setInterval(() => {
            self.fixCaches.apply(self, null);
        }, this.param('updateDelay') * 1000);

        //# Register callbacks for cache updates

        let messageUpdateHandler = async (oldMessage, message) => {
            
            let channelid = message.channel.id;
            await this.updateLatestCached(channelid);

            if (this._latestCached[channelid] && message.createdTimestamp / 1000 < this._latestCached[channelid]) {
                if (!this._dirty[channelid]) this._dirty[channelid] = {};
                this._dirty[channelid][message.id] = {ts: Math.round(message.editedTimestamp / 1000), text: message.cleanContent};
            }
            
        }
        
        let messageDeleteHandler = async (message) => {

            let channelid = message.channel.id;
            await this.updateLatestCached(channelid);

            if (this._latestCached[channelid] && message.createdTimestamp / 1000 < this._latestCached[channelid]) {
                if (!this._dirty[channelid]) this._dirty[channelid] = {};
                this._dirty[channelid][message.id] = {ts: moment().unix()};
            }

        }

        this.denv.client.on("messageUpdate", messageUpdateHandler);
        this.denv.client.on("messageDelete", messageDeleteHandler);

        //# Register commands
        
        this.be('Commands').registerCommand(this, 'download', {
            description: "Request a personal channel's history.",
            details: [
                "The following modes are available:",
                "  dump - Send only the channel data in a machine-readable (json) format.",
                "  rcdv - Send only the latest version of Rickety Channel Dump Viewer.",
                "  zip - Send a zip archive containing the channel data and the latest version of RCDV.",
                "  embedded (default) - Send a single HTML file with RCVD and the channel data embedded in it."
            ],
            args: ["mode"],
            minArgs: 0,
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.testEnv(env)) return true;

            let textchannel = await this.denv.server.channels.fetch(channelid);

            if (this.ownerCheck() && !await this.be('Users').testPermissions(env.name, userid, channelid, this.ownershipPermissions(env, channelid, textchannel.parentId))) {
                ep.reply("You don't have permission to do that here.");
                return true;
            }

            let mode = args.mode || 'embedded';
            mode = mode.toLowerCase();
            if (['dump', 'rcdv', 'zip', 'embedded'].indexOf(mode) < 0) {
                ep.reply("Unknown mode.");
                return true;
            }

            if (mode == "rcdv") {
                this.deliverRcdv(ep);
                return true;
            }

            let deliverance = (mode, ep, channel, cache) => {
                let fndt = moment.unix(cache.requestStart).format("YYYYMMDD_HHmm");
                if (mode == "embedded") {
                    this.deliverEmbed(ep, channel.name + "." + fndt + ".html", cache);
                } else if (mode == "zip") {
                    this.deliverZip(ep, channel.name + "." + fndt, cache);
                } else {
                    this.deliverDownload(ep, channel.name + "." + fndt + ".json", cache);
                }
            }

            let channel = env.server.channels.cache.get(channelid);
            let now = moment().unix();
            let cache = null;
            try {
                cache = await this.getCache(channelid);
            } catch (e) {}
            let after = null;

            if (cache) {
                if (cache.requestEnd > now - this.param("cacheTolerance")) {
                    deliverance(mode, ep, channel, cache);
                    return true;
                } else {
                    after = cache.messages[0].id;
                }
            }

            ep.reply("Please wait while I assemble your download. On very large channels this may take a minute.");

            this.queueScan(channel, (result) => {

                if (!cache) {
                    cache = result;
                } else {
                    cache = this.mergeCache(cache, result);
                }

                this._latestCached[channelid] = cache.requestStart;

                this.saveCache(channelid, cache)
                    .then(() => {
                        deliverance(mode, ep, channel, cache);
                    });

            }, after);

            return true;
        });

        

        return true;
    }
        
    
    // # Module code below this line #

    testEnv(env) {
        return env.name == this.denv.name;
    }

    ownerCheck() {
        return this.param("permissions") !== true;
    }

    ownershipPermissions(env, channelid, parentid) {
        return this.param("permissions").map(template => template
                    .replaceAll(/%env%/g, env.name)
                    .replaceAll(/%channelid%/g, channelid)
                    .replaceAll(/%parentid%/g, parentid || "noparent"));
    }

    cachePath(channelid) {
        if (!channelid) return undefined;
        return this.dataPath() + this.param("cachePath") + "/" + channelid + ".json";
    }

    async getCache(channelid) {
        return jsonfile.readFile(this.cachePath(channelid));
    }

    async getRcdv() {
        return new Promise((resolve, reject) => {
            fs.readFile(RCDV_PATH, {encoding: 'utf-8'}, (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data);
                }
            });
        });
    }

    mergeCache(older, newer) {
        for (let userid in older.users) {
            if (!newer.users[userid]) {
                newer.users[userid] = older.users[userid];
            }
        }
        newer.messages = newer.messages.concat(older.messages);
        return newer;
    }

    async saveCache(channelid, cache) {
        return jsonfile.writeFile(this.cachePath(channelid), cache);
    }

    queueScan(channel, callback, after, before, carry) {
        if (!carry) {
            carry = {
                requestStart: moment().unix(),
                requestEnd: null,
                serverid: channel.guild.id,
                channelid: channel.id,
                channelname: channel.name,
                users: {},
                messages: []
            };
        }
        this._scanQueue.push(() => {
            let myid = this.denv.client.realClient.user.id;
            channel.messages.fetch({
                limit: 100,
                before: before
            }).then((messages) => {
                let endNow = false;
                let messagesarr = [...messages.values()];
                if (messagesarr.length < 100) endNow = true;
                for (let message of messagesarr) {

                    if (message.id == after) {
                        endNow = true;
                        break;
                    }

                    let author = null;
                    if (message.member) {
                        author = {
                            id: message.member.id,
                            tag: message.member.user.tag,
                            bot: message.member.user.bot || undefined,
                            displayName: message.member.displayName,
                            displayHexColor: message.member.displayHexColor
                        }
                    } else if (message.author) {
                        author = {
                            id: message.author.id,
                            tag: message.author.tag,
                            bot: message.author.bot || undefined
                        }
                    }

                    if (author) {
                        if (author.id == myid) continue;
                        if (!carry.users[author.id]) {
                            carry.users[author.id] = author;
                        }
                    }

                    let attachments = [];
                    for (let att of message.attachments.values()) {
                        attachments.push({
                            n: att.name || null,
                            s: att.size,
                            w: att.width || undefined,
                            h: att.height || undefined,
                            u: att.url
                        });
                    }

                    carry.messages.push({
                        id: message.id,
                        au: (author ? author.id : null),
                        ct: Math.round(message.createdTimestamp / 1000),
                        et: (message.editedTimestamp ? Math.round(message.editedTimestamp / 1000) : undefined),
                        sy: message.system || undefined,
                        tp: (message.type == MessageType.Default ? undefined : Object.keys(MessageType).find(type => MessageType[type] === message.type)),
                        tx: message.cleanContent,
                        at: attachments.length ? attachments : undefined
                    });
                }
                if (endNow) {
                    carry.requestEnd = moment().unix();
                    callback(carry);
                } else {
                    this.queueScan(channel, callback, after, messagesarr[messagesarr.length - 1].id, carry);
                }
            });
        });
    }

    dequeueAndScan() {
        if (!this._scanQueue) return;
        let item = this._scanQueue.shift();
        if (!item) return;
        item();
    }

    deliverDownload(ep, filename, json) {
        ep.priv(new AttachmentBuilder(Buffer.from(JSON.stringify(json)), {name: filename}));
    }

    deliverRcdv(ep) {
        this.getRcdv().then((contents) => ep.priv(new AttachmentBuilder(Buffer.from(contents), {name: "rcdv.html"})));
    }

    deliverEmbed(ep, filename, json) {
        this.getRcdv().then((rcdv) => ep.priv(
            new AttachmentBuilder(Buffer.from(
                rcdv.replace(/let predump = null; \/\*CHANNEL DUMP STRING\*\//, "let predump = decodeURIComponent('"
                    + encodeURIComponent(JSON.stringify(json)).replace(/(')/g, "\\$1")
                    + "'); /*CHANNEL DUMP STRING*/"
                )
            ), {name: filename})
        ));
    }

    deliverZip(ep, filename, json) {
        let zip = new jszip();
        this.getRcdv().then((rcdv) => {
            zip.file("rcdv.html", rcdv);
            zip.file(filename + ".json", JSON.stringify(json));
            zip.generateAsync({
                type:'nodebuffer',
                compression: 'DEFLATE',
            }).then((buffer) => {
                ep.priv(new AttachmentBuilder(buffer, {name: filename + ".zip"}));
            });
        });
    }

    fixCaches() {
        for (let channelid in this._dirty) {
            let changes = this._dirty[channelid];
            this.getCache(channelid)
                .then((cached) => {
                    let newmessages = [];
                    for (let message of cached.messages) {
                        if (!changes[message.id]) {
                            newmessages.push(message);
                        } else if (changes[message.id].text) {
                            message.tx = changes[message.id].text;
                            message.et = changes[message.id].ts;
                            newmessages.push(message);
                        } else {
                        }
                    }
                    cached.messages = newmessages;
                    this.saveCache(channelid, cached);
                });
            delete this._dirty[channelid];
        }
    }

    async updateLatestCached(channelid) {
        //Initialize entry in _latestCached for channelid
        if (this._latestCached[channelid] === undefined) {
            if (!fs.existsSync(this.cachePath(channelid))) {
                this._latestCached[channelid] = null;
            } else {
                let cache = await this.getCache(channelid);
                this._latestCached[channelid] = cache.requestStart;
            }
        }
    }


}
