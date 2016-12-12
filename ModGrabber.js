/* Module: Grabber -- Downloads song files referenced in a Discord channel and maintains a dynamic index w/ API. */

var Module = require('./Module.js');
var fs = require('fs');
var ytdl = require('ytdl-core');
var FFmpeg = require('fluent-ffmpeg');
var crypto = require('crypto');
var jsonfile = require('jsonfile');
var moment = require('moment');

var PERM_ADMIN = 'administrator';
var PERM_MODERATOR = 'moderator';
var PERM_TRUSTED = 'trusted';
var INDEXFILE = 'index.json';

var GET_FIELDS = ['name', 'author', 'length', 'source', 'sourceSpecificId', 'sharedBy'];
var SET_FIELDS = ['name', 'author'];


class ModGrabber extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channels'              //List of IDs of the Discord channels to be used
    ]; }
    
    get optionalParams() { return [
        'downloadPath',         //Path to store the downloaded files (index.json will also be created)
        'minDuration',          //Minimum duration of the audio file (seconds)
        'maxDuration',          //Maximum duration of the audio file (seconds)
        'maxDiskUsage',         //Amount of disk space grabber is allowed to use in the downloadPath excluding index (bytes)
        'maxSimDownloads',      //Maximum simultaneous downloads
        'scanDelay'             //Delay between attempts to process messages (pending messages are queued) (ms)
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Grabber', name);
        
        this._params['downloadPath'] = "songs";
        this._params['minDuration'] = 90;
        this._params['maxDuration'] = 1500;
        this._params['maxDiskUsage'] = null;
        this._params['maxSimDownloads'] = 2;
        this._params['scanDelay'] = 200;
        
        this._preparing = 0;  //Used for generating temporary filenames
        
        this._index = {};  //Main index (hash => info)
        this._indexSourceTypeAndId = {};  //{sourceType: {sourceId: ...}}
        
        this._usage = 0;  //Cache disk usage (by mp3s only)
        this._sessionGrabs = [];  //History of hashes grabbed in this session
        
        this._scanQueue = [];  //Rate-limit song downloads. Each item is: [authorid, messageToScan]
        this._scanTimer = null;
        this._downloads = 0;
    }
    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;


        //Load index
        
        if (!this.loadIndex()) return false;
        this.calculateDownloadPathUsage();
        
        
        //Queue processor
        
        var self = this;
        
        this._scanTimer = setInterval(() => {
                self.dequeueAndScan.apply(self, null)
            }, this.param('scanDelay'));

      
        //Register callbacks
        
        if (!envs[this.param('env')]) {
            this.log('error', "Environment not found.");
            return false;
        }
        
        envs[this.param('env')].registerOnMessage(this.onMessage, this);
        
        
        this.mod('Commands').registerCommand('grabscan', {
            description: 'Scans channel history until INTERVAL days ago and grabs any song files.',
            args: ['channelid', 'interval'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, command, args, handle, reply) => {
        
            var channel = env.server.channels.find('id', args.channelid);
            if (!channel) return false;
            
            var endNow = false;
            var cutoff = (moment().unix() - args.interval * 86400) * 1000;
            
            reply("Scanning...");
            
            var scanning = null;
            var scanner = () => {
                channel.fetchMessages({
                    limit: 100,
                    before: scanning
                }).then((messages) => {
                    let messagesarr = messages.array();
                    if (messagesarr.length < 100) endNow = true;
                    for (let message of messagesarr) {
                        if (message.createdTimestamp <= cutoff) endNow = true;
                        this._scanQueue.push([message.author.id, message.content]);
                    }
                    if (endNow) {
                        reply("Scan complete.");
                    } else {
                        scanning = messagesarr[messagesarr.length - 1].id;
                        setTimeout(scanner, 250);
                    }
                });
            };
            scanner();
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand('grabundo', {
            description: 'Undo a single recent grab from this session.',
            args: ['offset'],
            minArgs: 0,
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, command, args, handle, reply) => {
        
            if (!args.offset || args.offset < 1) args.offset = 1;
        
            if (args.offset > 20) {
                reply('Offset too high. Use grabdelete instead.');
                return true;
            }
        
            if (args.offset > this._sessionGrabs.length) {
                reply('Offset not found in recent history.');
                return true;
            }
            
            var info = this._index[this._sessionGrabs[args.offset - 1][0]];
            if (info) {
                if (info.seen.length > 1) {
                    info.seen = info.seen.filter((ts) => ts != this._sessionGrabs[args.offset - 1][1]);
                } else {
                    this.removeByHash(info.hash);
                }
                reply('Ok.');
            } else {
                reply('Historic hash not found in index! I will just remove it from the history.');
            }
            
            this._sessionGrabs.splice(args.offset - 1, 1);
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand('grabdelete', {
            description: 'Delete an indexed song by hash.',
            args: ['hash'],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, command, args, handle, reply) => {
                    
            if (this.removeByHash(args.hash)) {
                this._sessionGrabs = this._sessionGrabs.filter((item) => item[0] != args.hash);
                reply('Ok.');
            } else {
                reply('Hash not found.');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand('songfind', {
            description: 'Find an indexed song.',
            args: ['searchstr', true]
        }, (env, type, userid, command, args, handle, reply) => {
        
            var search = new RegExp(args.searchstr.join(' ').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(' ', '.*'), 'i');
            
            var results = [];
            for (let hash in this._index) {
                let info = this._index[hash];
                if (info.hash.match(search) || info.sharedBy.find((e, i, a) => e.match(search)) || info.source.match(search) || info.name.match(search) || info.author.match(search) || info.keywords.find((e, i, a) => e.match(search))) {
                    results.push(info);
                }
            }
            
            results = results.slice(0, 10);
            
            for (let info of results) {
                reply(info.hash + ' ' + info.name + ' (' + info.author + ')');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand('songset', {
            description: 'Change metadata of an indexed song.',
            details: [
                "Allowed fields: " + SET_FIELDS.join(', ')
            ],
            args: ['hash', 'field', 'value', true],
            permissions: [PERM_ADMIN, PERM_MODERATOR, PERM_TRUSTED]
        }, (env, type, userid, command, args, handle, reply) => {
        
            if (!this._index[args.hash]) {
                reply("Song not found in index.");
                return true;
            }
            
            if (SET_FIELDS.indexOf(args.field) < 0) {
                reply("Invalid field name.");
                return true;
            }
            
            this._index[args.hash][args.field] = args.value.join(' ');
            
            this.saveIndex();
            
            reply("Ok.");
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand('songget', {
            description: 'Retrieve metadata of an indexed song.',
            details: [
                "Allowed fields: " + GET_FIELDS.join(', ')
            ],
            args: ['hash', 'field']
        }, (env, type, userid, command, args, handle, reply) => {
        
            if (!this._index[args.hash]) {
                reply("Song not found in index.");
                return true;
            }
            
            if (GET_FIELDS.indexOf(args.field) < 0) {
                reply("Invalid field name.");
                return true;
            }
            
            reply('"' + this._index[args.hash][args.field] + '"');
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand('songkw', {
            description: 'Manipulate keywords associated with a song.',
            details: [
                "The actions can be 'list', 'add' or 'remove'."
            ],
            args: ['hash', 'action', 'keyword'],
            minArgs: 1,
            permissions: [PERM_ADMIN, PERM_MODERATOR, PERM_TRUSTED]
        }, (env, type, userid, command, args, handle, reply) => {
        
            if (!this._index[args.hash]) {
                reply("Song not found in index.");
                return true;
            }
            
            if (!this._index[args.hash].keywords || typeof this._index[args.hash].keywords != "object") {
                this._index[args.hash].keywords = [];
            }
            
            if (args.action == "add" && args.keyword) {
                
                if (this._index[args.hash].keywords.indexOf(args.keyword) < 0) {
                    this._index[args.hash].keywords.push(args.keyword);
                    this.saveIndex();
                    reply("Ok.");
                } else {
                    reply("Already existed.");
                }
            
            } else if (args.action == "remove" && args.keyword) {
                
                let ind = this._index[args.hash].keywords.indexOf(args.keyword);
                if (ind > -1) {
                    this._index[args.hash].keywords.splice(ind, 1);
                    this.saveIndex();
                    reply("Ok.");
                } else {
                    reply("Doesn't exist.");
                }
                
            } else {
            
                reply("Keywords: " + this._index[args.hash].keywords.join(', '));
            
            }
            
            return true;
        });
        
        
        return true;
    }
    
    
    // # Module code below this line #
    
    
    //Index file manipulation

    loadIndex() {
        var indexfile = this.param('downloadPath') + '/' + INDEXFILE;
     
        try {
            fs.accessSync(indexfile, fs.F_OK);
        } catch (e) {
            jsonfile.writeFileSync(indexfile, {});
        }

        try {
            this._index = jsonfile.readFileSync(indexfile);
        } catch (e) {
            return false;
        }
        if (!this._index) this._index = {};
        
        for (let hash in this._index) {
            let info = this._index[hash];
            if (!this._indexSourceTypeAndId[info.sourceType]) {
                this._indexSourceTypeAndId[info.sourceType] = {};
            }
            this._indexSourceTypeAndId[info.sourceType][info.sourceSpecificId] = info;
        }
        
        return true;
    }

    saveIndex() {
        var indexfile = this.param('downloadPath') + '/' + INDEXFILE;
        
        jsonfile.writeFileSync(indexfile, this._index, {spaces: 4});
    }
    
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (this.param('channels').indexOf(channelid) < 0) return false;
        this._scanQueue.push([authorid, message]);
    }
    
    
    grabInMessage(author, message) {
        if (this.isDownloadPathFull() || !message) return false;
    
        var dkeywords = message.match(/\[[A-Za-z0-9 _-]+\]/g);
        var title = message.match(/\{(title|name)(=|:) ?([A-Za-z0-9 _-]+)\}/i);
        if (title) title = title[3];
        var artist = message.match(/\{(author|artist|band)(=|:) ?([A-Za-z0-9 _-]+)\}/i);
        if (artist) artist = artist[3];
    
        //Youtube
        var yturls = message.match(/(?:https?:\/\/|\/\/)?(?:www\.|m\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})(?![\w-])/g);
        if (yturls) {
            for (let url of yturls) {
                try {
                    //Obtain metadata from youtube
                    ytdl.getInfo(url, (err, info) => {
                        if (err) {
                            this.log('warn', err);
                            return;
                        }
                        
                        if (info.length_seconds < this.param('minDuration') || info.length_seconds > this.param('maxDuration')) return;
                        if (this._indexSourceTypeAndId['youtube'] && this._indexSourceTypeAndId['youtube'][info.video_id]) return;
                        
                        let keywords = info.keywords;
                        if (typeof keywords == "string") {
                            if (keywords) keywords = keywords.split('');
                            else keywords = [];
                        }
                        if (dkeywords) {
                            for (let dkeyword of dkeywords) {
                                let ikeyword = dkeyword.match(/^\[([^\]]+)\]$/);
                                if (!ikeyword) continue;
                                if (keywords.indexOf(ikeyword[1]) < 0) {
                                    keywords.push(ikeyword[1]);
                                }
                            }
                        }
                        
                        this.log('Grabbing from youtube: ' + url);
                        
                        this._downloads += 1;
                    
                        //Prepare video download and ffmpeg
                        let video = ytdl(url, {filter: 'audioonly'});
                        let ffmpeg = new FFmpeg(video);
                        
                        //Prepare stream for writing to disk
                        let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                        let stream = fs.createWriteStream(temppath);
                        
                        stream.on('finish', () => {
                            this._downloads -= 1;
                        
                            //After the file is fully written, computer hash, rename file and add to index
                            fs.readFile(temppath, (err, data) => {
                                if (err) throw err;
                                
                                let hash = crypto.createHash('md5').update(data).digest('hex');
                                let realpath = this.param('downloadPath') + '/' + hash + '.mp3';
                                
                                let now = moment().unix();
                                
                                if (fs.existsSync(realpath)) {
                                    fs.unlink(temppath);
                                    this._index[hash].seen.push(now);
                                    if (this._index[hash].sharedBy.indexOf(author) < 0) {
                                        this._index[hash].sharedBy.push(author);
                                    }
                                    this.saveIndex();
                                    this.log('  Already existed: ' + url + '  (as ' + hash + ')');
                                    return;
                                }
                                
                                this._usage += fs.statSync(temppath).size;
                                
                                fs.rename(temppath, realpath, (err) => {
                                    if (err) throw err;
                                
                                    this._index[hash] = {
                                        hash: hash,
                                        seen: [now],
                                        sharedBy: [author],
                                        length: parseInt(info.length_seconds),
                                        source: url,
                                        sourceType: 'youtube',
                                        sourceSpecificId: info.video_id,
                                        sourceLoudness: parseFloat(info.loudness),
                                        name: (title || info.title),
                                        author: (artist || ''),
                                        keywords: keywords
                                    };
                                    this.saveIndex();
                                    
                                    if (!this._indexSourceTypeAndId['youtube']) {
                                        this._indexSourceTypeAndId['youtube'] = {};
                                    }
                                    this._indexSourceTypeAndId['youtube'][info.video_id] = this._index[hash];
                                    
                                    this._sessionGrabs.push([hash, now]);
                                    
                                    this.log('  Successfully grabbed from youtube: ' + url + '  (as ' + hash + ')');
                                });
                                
                            });
                            
                        });
                        
                        //Download, convert and save file
                        let output = ffmpeg.format('mp3').pipe(stream);
                        output.on('error', video.end.bind(video));
                        output.on('error', stream.emit.bind(stream, 'error'));
                    });
                } catch (exception) {
                    this.log('error', exception);
                }
            }
        }
        
        return true;
    }
    
    
    calculateDownloadPathUsage() {
        var total = 0;
        for (let file of fs.readdirSync(this.param('downloadPath'))) {
            if (!file.match(/\.mp3$/)) continue;
            total += fs.statSync(this.param('downloadPath') + '/' + file).size;
        }
        this._usage = total;
    }
    
    isDownloadPathFull() {
        if (!this.param('maxDiskUsage')) return false;
        return this._usage > this.param('maxDiskUsage');
    }
    
    
    removeByHash(hash) {
        if (!this._index[hash]) return false;
        fs.unlink(this.param('downloadPath') + '/' + hash + '.mp3');
        delete this._index[hash];
        return true;
    }
    
    
    dequeueAndScan() {
        if (!this._scanQueue) return;
        if (this._downloads >= this.param('maxSimDownloads')) return;
        var item = this._scanQueue.shift();
        if (!item) return;
        this.grabInMessage(item[0], item[1]);
    }
    

}


module.exports = ModGrabber;
