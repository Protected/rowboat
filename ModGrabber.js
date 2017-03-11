/* Module: Grabber -- Downloads song files referenced in a Discord channel and maintains a dynamic index w/ API. */

var Module = require('./Module.js');
var fs = require('fs');
var ytdl = require('ytdl-core');
var FFmpeg = require('fluent-ffmpeg');
var crypto = require('crypto');
var jsonfile = require('jsonfile');
var moment = require('moment');
var random = require('meteor-random');
var request = require('request');

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
        
        this._apiCbNewSong = [];  //List of callbacks called when new songs are added. Return true to stop processing.
        this._apiCbGrabscanExists = [];  //List of callbacks called when existing songs are detected by a grabscan call. Return true to stop processing.
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
        
        envs[this.param('env')].on('message', this.onMessage, this);
        
        
        this.mod('Commands').registerCommand(this, 'grabscan', {
            description: 'Scans channel history until INTERVAL days ago and grabs any song files.',
            args: ['channelid', 'interval'],
            environments: ['Discord'],
            permissions: [PERM_ADMIN]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var channel = env.server.channels.get(args.channelid);
            if (!channel) return false;
            
            var endNow = false;
            var cutoff = (moment().unix() - args.interval * 86400) * 1000;
            
            ep.reply("Scanning...");
            
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
                        this._scanQueue.push([message, {
                            exists: (messageObj, messageAuthor, reply, hash) => {
                                this.processOnGrabscanExists(messageObj, messageAuthor, reply, hash);
                            }
                        }]);
                    }
                    if (endNow) {
                        ep.reply("Scan complete.");
                    } else {
                        scanning = messagesarr[messagesarr.length - 1].id;
                        setTimeout(scanner, 250);
                    }
                });
            };
            scanner();
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grabundo', {
            description: 'Undo a single recent grab from this session.',
            args: ['offset'],
            minArgs: 0,
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!args.offset || args.offset > -1) args.offset = -1;
        
            if (args.offset < -20) {
                ep.reply('Offset too high. Use grabdelete instead.');
                return true;
            }
        
            if (-args.offset > this._sessionGrabs.length) {
                ep.reply('Offset not found in recent history.');
                return true;
            }
            
            var info = this._index[this._sessionGrabs[-args.offset - 1][0]];
            if (info) {
                if (info.seen.length > 1) {
                    info.seen = info.seen.filter((ts) => ts != this._sessionGrabs[-args.offset - 1][1]);
                } else {
                    this.removeByHash(info.hash);
                }
                ep.reply('Ok.');
            } else {
                ep.reply('Historic hash not found in index! I will just remove it from the history.');
            }
            
            this._sessionGrabs.splice(-args.offset - 1, 1);
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grabdelete', {
            description: 'Delete an indexed song by hash.',
            args: ['hashoroffset'],
            permissions: [PERM_ADMIN, PERM_MODERATOR]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
                    
            var hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
                    
            if (this.removeByHash(hash)) {
                this._sessionGrabs = this._sessionGrabs.filter((item) => item[0] != hash);
                ep.reply('Ok.');
            } else {
                ep.reply('Hash not found.');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'grablatest', {
            description: 'Get the hash of a single recent song.',
            args: ['hashoroffset'],
            minArgs: 0
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
            
            ep.reply('`' + hash + '`');
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'songfind', {
            description: 'Find an indexed song.',
            details: [
                'Use -p PAGE before the search string to access result pages beyond the first one (if available).',
                'You can filter by multiple independent search strings by using SEARCHSTR & SEARCHSTR & ...'
            ],
            args: ['searchstr', true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let page = 0;
            let searchstr = args.searchstr;
            
            if (searchstr[0] == '-p' && !isNaN(parseInt(searchstr[1]))) {
                if (parseInt(searchstr[1]) >= 0) {
                    page = parseInt(searchstr[1]);
                    searchstr.shift();
                    searchstr.shift();
                }
            }
            
            searchstr = searchstr.join(' ');
        
            let results = this.filterSongsBySearchString(searchstr);
            if (!results.length) {
                ep.reply("No results.");
            }
            
            results = results.slice(page * 10, page * 10 + 10);
            
            for (let info of results) {
                ep.reply('`' + info.hash + ' ' + info.name + (info.author ? ' (' + info.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'songset', {
            description: 'Change metadata of an indexed song.',
            details: [
                "Allowed fields: " + SET_FIELDS.join(', ')
            ],
            args: ['hashoroffset', 'field', 'value', true],
            permissions: [PERM_ADMIN, PERM_MODERATOR, PERM_TRUSTED]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (SET_FIELDS.indexOf(args.field) < 0) {
                ep.reply("Invalid field name.");
                return true;
            }
            
            this._index[hash][args.field] = args.value.join(' ');
            
            this.saveIndex();
            
            ep.reply("Ok.");
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'songget', {
            description: 'Retrieve metadata of an indexed song.',
            details: [
                "Allowed fields: " + GET_FIELDS.join(', ')
            ],
            args: ['hashoroffset', 'field']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (GET_FIELDS.indexOf(args.field) < 0) {
                ep.reply("Invalid field name.");
                return true;
            }
            
            ep.reply(this._index[hash][args.field]);
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'songkw', {
            description: 'Manipulate keywords associated with a song.',
            details: [
                "The actions can be 'list', 'add' or 'remove'."
            ],
            args: ['hashoroffset', 'action', 'keyword'],
            minArgs: 1,
            permissions: [PERM_ADMIN, PERM_MODERATOR, PERM_TRUSTED]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.parseHashArg(args.hashoroffset);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
        
            if (!this._index[hash]) {
                ep.reply("Song not found in index.");
                return true;
            }
            
            if (!this._index[hash].keywords || typeof this._index[hash].keywords != "object") {
                this._index[hash].keywords = [];
            }
            
            if (args.action == "add" && args.keyword) {
                
                if (this._index[hash].keywords.indexOf(args.keyword) < 0) {
                    this._index[hash].keywords.push(args.keyword);
                    this.saveIndex();
                    ep.reply("Ok.");
                } else {
                    ep.reply("Already existed.");
                }
            
            } else if (args.action == "remove" && args.keyword) {
                
                let ind = this._index[hash].keywords.indexOf(args.keyword);
                if (ind > -1) {
                    this._index[hash].keywords.splice(ind, 1);
                    this.saveIndex();
                    ep.reply("Ok.");
                } else {
                    ep.reply("Doesn't exist.");
                }
                
            } else {
            
                ep.reply("Keywords: " + this._index[hash].keywords.join(', '));
            
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
    
    
    //Message processing
    
    onMessage(env, type, message, authorid, channelid, rawobj) {
        if (env.name != this.param('env')) return false;
        if (this.param('channels').indexOf(channelid) < 0) return false;
        this._scanQueue.push([rawobj, {
            accepted: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply("Got it, " + messageAuthor + ".");
            },
            exists: (messageObj, messageAuthor, reply, hash) => {
                if (reply) reply(messageAuthor + ", the song was already known (" + hash + ").");
            },
            errorDuration: (messageObj, messageAuthor, reply, label) => {
                if (reply) reply(messageAuthor + ", I only index songs with a duration between " + this.param('minDuration') + " and " + this.param('maxDuration') + " seconds.");
            }
        }]);
    }
    
    
    extractMessageInfo(message) {
        var warnauthor = !!message.match(/^!!/);
    
        var dkeywords = message.match(/\[[A-Za-z0-9\u{3040}-\u{D7AF}\(\)' _-]+\]/gu);
        if (!dkeywords) dkeywords = [];
        dkeywords = dkeywords.map((item) => {
            let ikeyword = item.match(/^\[([^\]]+)\]$/u);
            if (!ikeyword) return null;
            return ikeyword[1];
        }).filter((item) => item);
        
        var title = message.match(/\{(title|name|song)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' _-]+)\}/iu);
        if (title) title = title[3];
        var artist = message.match(/\{(author|artist|band)(=|:) ?([A-Za-z0-9\u{3040}-\u{D7AF}\(\)' _-]+)\}/iu);
        if (artist) artist = artist[3];
        
        var interval = null;
        if (title) {
            interval = message.match(/<(([0-9:]+)?(,[0-9:]+)?)>/);
            if (interval) interval = this.parseInterval(interval[1]);
        }
        
        return {
            warnauthor: warnauthor,
            keywords: dkeywords,
            title: title,
            artist: artist,
            interval: interval
        };
    }
    
    
    /* Callbacks:
        accepted(messageObj, messageAuthor, reply, hash) - The song has just been indexed as a result of this call (details can be retrieved from the index)
        exists(messageObj, messageAuthor, reply, hash) - A song already existed (details can be retrieved from the index)
        errorDuration(messageObj, messageAuthor, reply, label) - A song fails a duration check
        reply is either a function for replying to the environent (if the message is tagged for feedback) or null
    */
    grabInMessage(messageObj, callbacks, readOnly) {
        if (this.isDownloadPathFull() || !messageObj) return false;
        
        var message = messageObj.content;
        var author = messageObj.author.id;
        var messageAuthor = this.env(this.param('env')).idToDisplayName(author);
        
        var messageInfo = this.extractMessageInfo(message);
        var interval = messageInfo.interval;
        var reply = (messageInfo.warnauthor ? (out) => this.env(this.param('env')).msg(messageObj.channel.id, out) : null);
    
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
                        
                        if (info.length_seconds < this.param('minDuration') || interval && interval[1] - interval[0] < this.param('minDuration')
                                || info.length_seconds > this.param('maxDuration') && (!interval || interval[1] - interval[0] > this.param('maxDuration'))) {
                            if (callbacks.errorDuration) callbacks.errorDuration(messageObj, messageAuthor, reply, info.title);
                            return;
                        }
                                
                        if (this._indexSourceTypeAndId['youtube'] && this._indexSourceTypeAndId['youtube'][info.video_id]
                                && !this._indexSourceTypeAndId['youtube'][info.video_id].sourcePartial && !interval) {
                            if (callbacks.exists) callbacks.exists(messageObj, messageAuthor, reply, this._indexSourceTypeAndId['youtube'][info.video_id].hash);
                            return;
                        }
                        
                        let keywords = info.keywords;
                        if (typeof keywords == "string") {
                            if (keywords) keywords = keywords.split('');
                            else keywords = [];
                        }
                        for (let dkeyword of messageInfo.keywords) {
                            keywords.push(dkeyword);
                        }
                        
                        this.log('Grabbing from youtube: ' + url);
                        
                        this._downloads += 1;
                    
                        //Plug video download into ffmpeg
                        let video = ytdl(url, {filter: 'audioonly'});
                        let ffmpeg = new FFmpeg(video);
                        
                        if (interval) ffmpeg.seekInput(interval[0]).duration(interval[1] - interval[0]);
                        
                        //Prepare stream for writing to disk
                        let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                        let stream = fs.createWriteStream(temppath);
                        
                        stream.on('finish', () => {
                            this._downloads -= 1;
                        
                            //After the file is fully written, compute hash, rename file and add to index
                            fs.readFile(temppath, (err, data) => {
                                if (err) throw err;
                                
                                let hash = crypto.createHash('md5').update(data).digest('hex');
                                let realpath = this.param('downloadPath') + '/' + hash + '.mp3';
                                
                                let now = moment().unix();
                                
                                if (fs.existsSync(realpath)) {
                                    fs.unlink(temppath);
                                    this.log('  Already existed: ' + url + '  (as ' + hash + ')');
                                    if (!readOnly) {
                                        this._index[hash].seen.push(now);
                                        if (this._index[hash].sharedBy.indexOf(author) < 0) {
                                            this._index[hash].sharedBy.push(author);
                                        }
                                        this.saveIndex();
                                    }
                                    if (callbacks.exists) callbacks.exists(messageObj, messageAuthor, reply, hash);
                                    return;
                                }
                                
                                if (readOnly) {
                                    fs.unlink(temppath);
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
                                        sourcePartial: interval,
                                        name: (messageInfo.title || info.title),
                                        author: (messageInfo.artist || ''),
                                        keywords: keywords
                                    };
                                    this.saveIndex();
                                    
                                    if (!this._indexSourceTypeAndId['youtube']) {
                                        this._indexSourceTypeAndId['youtube'] = {};
                                    }
                                    this._indexSourceTypeAndId['youtube'][info.video_id] = this._index[hash];
                                    
                                    this._sessionGrabs.unshift([hash, now]);
                                    
                                    this.log('  Successfully grabbed from youtube: ' + url + '  (as ' + hash + ')');
                                    if (callbacks.accepted) callbacks.accepted(messageObj, messageAuthor, reply, hash);
                                    this.processOnNewSong(messageObj, messageAuthor, reply, hash);
                                });
                                
                            });
                            
                        });
                        
                        //Plug ffmpeg into writing stream
                        let output = ffmpeg.format('mp3').pipe(stream);
                        output.on('error', video.end.bind(video));
                        output.on('error', stream.emit.bind(stream, 'error'));
                    });
                } catch (exception) {
                    this.log('error', exception);
                }
            }
        }
        
        
        //Attachment
        if (messageObj.attachments && messageObj.attachments.array().length) {
            for (let ma of messageObj.attachments.array()) {
                if (!ma.filename.match(/\.(mp3|ogg|flac|wav|wma|aac|m4a)$/) || ma.filesize < 20480) continue;
                try {
                
                    //Download attachment
                    this.log('Grabbing from attachment: ' + ma.filename + ' (' + ma.id + ')');
                    
                    this._downloads += 1;
                
                    //Plug attachment download into ffmpeg
                    let attfiledl = request(ma.url);
                    let ffmpeg = new FFmpeg(attfiledl);
                    
                    if (interval) ffmpeg.seekInput(interval[0]).duration(interval[1] - interval[0]);
                    
                    //Prepare stream for writing to disk
                    let temppath = this.param('downloadPath') + '/' + 'dl_' + (this._preparing++) + '.tmp';
                    let stream = fs.createWriteStream(temppath);
                    
                    stream.on('finish', () => {
                        this._downloads -= 1;
                        
                        //Get song info
                        FFmpeg(temppath).ffprobe((err, info) => {
                            if (err) {
                                this.log('warn', err);
                                return;
                            }
            
                            let duration = parseFloat(info.format.duration || info.streams[0].duration);
                            if (duration < this.param('minDuration') || duration > this.param('maxDuration')) {
                                if (callbacks.errorDuration) callbacks.errorDuration(messageObj, messageAuthor, reply, info.title);
                                return;
                            }
                            
                            let keywords = messageInfo.dkeywords;
                            
                            //Compute hash, rename file and add to index
                            fs.readFile(temppath, (err, data) => {
                                if (err) throw err;
                                
                                let hash = crypto.createHash('md5').update(data).digest('hex');
                                let realpath = this.param('downloadPath') + '/' + hash + '.mp3';
                                
                                let now = moment().unix();
                                
                                if (fs.existsSync(realpath)) {
                                    fs.unlink(temppath);
                                    this.log('  Already existed: ' + ma.filename + '  (as ' + hash + ')');
                                    if (!readOnly) {
                                        this._index[hash].seen.push(now);
                                        if (this._index[hash].sharedBy.indexOf(author) < 0) {
                                            this._index[hash].sharedBy.push(author);
                                        }
                                        this.saveIndex();
                                    }
                                    if (callbacks.exists) callbacks.exists(messageObj, messageAuthor, reply, hash);
                                    return;
                                }
                                
                                if (readOnly) {
                                    fs.unlink(temppath);
                                    return;
                                }
                                
                                this._usage += fs.statSync(temppath).size;
                                
                                fs.rename(temppath, realpath, (err) => {
                                    if (err) throw err;
                                
                                    let title = ma.filename;
                                    let artist = '';
                                    if (info.format && info.format.tags) {
                                        if (info.format.tags.title) title = info.format.tags.title;
                                        if (info.format.tags.artist) artist = info.format.tags.artist;
                                    }
                                    if (messageInfo.title) title = messageInfo.title;
                                    if (messageInfo.artist) artist = messageInfo.artist;
                                
                                    this._index[hash] = {
                                        hash: hash,
                                        seen: [now],
                                        sharedBy: [author],
                                        length: Math.floor(duration),
                                        source: ma.url,
                                        sourceType: 'discord',
                                        sourceSpecificId: ma.id,
                                        sourceLoudness: null,
                                        sourcePartial: interval,
                                        name: title,
                                        author: artist,
                                        keywords: keywords
                                    };
                                    this.saveIndex();
                                    
                                    if (!this._indexSourceTypeAndId['discord']) {
                                        this._indexSourceTypeAndId['discord'] = {};
                                    }
                                    this._indexSourceTypeAndId['discord'][ma.id] = this._index[hash];
                                    
                                    this._sessionGrabs.unshift([hash, now]);
                                    
                                    this.log('  Successfully grabbed from discord: ' + ma.filename + '  (as ' + hash + ')');
                                    if (callbacks.accepted) callbacks.accepted(messageObj, messageAuthor, reply, hash);
                                    this.processOnNewSong(messageObj, messageAuthor, reply, hash);
                                });
                                
                            });
                            
                        });
                        
                    });
                    
                    //Plug ffmpeg into writing stream
                    let output = ffmpeg.format('mp3').pipe(stream);
                    output.on('error', attfiledl.end.bind(attfiledl));
                    output.on('error', stream.emit.bind(stream, 'error'));
                    
                } catch (exception) {
                    this.log('error', exception);
                }
            }
        }
        
        
        return true;
    }
    
    
    //Download path
    
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
    
    
    //Other auxiliary methods
    
    parseHashArg(hashoroffset) {
        if (!hashoroffset) hashoroffset = "-";
        else if (typeof hashoroffset != "string") return null;
        hashoroffset = hashoroffset.trim();
        var offset = hashoroffset.match(/^-([0-2]?[0-9])?/);
        if (offset) {
            if (offset[1] == 0) return null;
            if (!offset[1]) offset[1] = 1;
            offset = offset[1];
            if (offset > this._sessionGrabs.length) {
                return false;
            }
            return this._sessionGrabs[offset - 1][0];
        } else if (hashoroffset.length == 32) {
            return hashoroffset;
        }
        return null;
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
        if (!item[1]) item[1] = {};
        if (!item[2]) item[2] = false;
        this.grabInMessage(item[0], item[1], item[2]);
    }
    
    
    filterSongsBySearchString(searchstr) {
        var filters = searchstr.split(' & ');
        if (!filters.length) return [];
        
        var results = [];
        for (let hash in this._index) results.push(this._index[hash]);

        for (let filter of filters) {
            let regexfilter = new RegExp(filter.replace(/[-\/\\^$*+?.()|[\]{}]/gu, '\\$&').replace(' ', '.*'), 'i');
            results = results.filter(
                (info) => info.hash.match(regexfilter) || info.sharedBy.find((e, i, a) => e.match(regexfilter)) || info.source.match(regexfilter) || info.name.match(regexfilter) || info.author.match(regexfilter) || info.keywords.find((e, i, a) => e.match(regexfilter))
            );
        }
        
        return results;
    }
    
    
    parseInterval(intervalstring) {  //"00:00:00,23:59:59" => [minseconds, maxseconds]
        if (!intervalstring) return [0, 0];
        var parts = intervalstring.split(',');
        var min = parts[0] || "0";
        var max = parts[1] || String(Number.MAX_SAFE_INTEGER);
        var minparts = min.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        var actualmin = (minparts ? parseInt(minparts[5]) + (parseInt(minparts[4])||0) * 60 + (parseInt(minparts[3])||0) * 3600 : 0);
        var maxparts = max.match(/((([0-9]+):)?([0-9]{1,2}):)?([0-9]+)/);
        var actualmax = (maxparts ? parseInt(maxparts[5]) + (parseInt(maxparts[4])||0) * 60 + (parseInt(maxparts[3])||0) * 3600 : Number.MAX_SAFE_INTEGER);
        if (actualmin > Number.MAX_SAFE_INTEGER) actualmin = Number.MAX_SAFE_INTEGER;
        if (actualmax < actualmin) actualmax = actualmin;
        return [actualmin, actualmax];
    }
    
    
    processOnNewSong(messageObj, messageAuthor, reply, hash) {
        for (let cb of this._apiCbNewSong) {
            try {
                let r;
                if (typeof cb == "function") {
                    r = cb.apply(this, [messageObj, messageAuthor, reply, hash]);
                } else {
                    r = cb[0].apply(cb[1], [messageObj, messageAuthor, reply, hash]);
                }
                if (r) break;
            } catch (exception) {
                this.log('error', 'Error in callback after adding ' + hash);
            }
        }
    }
    
    
    processOnGrabscanExists(messageObj, messageAuthor, reply, hash) {
        for (let cb of this._apiCbGrabscanExists) {
            try {
                let r;
                if (typeof cb == "function") {
                    r = cb.apply(this, [messageObj, messageAuthor, reply, hash]);
                } else {
                    r = cb[0].apply(cb[1], [messageObj, messageAuthor, reply, hash]);
                }
                if (r) break;
            } catch (exception) {
                this.log('error', 'Error in callback after detecting existing ' + hash);
            }
        }
    }
    
    
    // # API #
    
    
    randomSong() {
        var allhashes = Object.keys(this._index);
        if (!allhashes.length) return null;
        var hash = allhashes[Math.floor(random.fraction() * allhashes.length)];
        return this._index[hash];
    }
    
    
    latestSong() {
        if (!this._sessionGrabs.length) return null;
        return this._index[this._sessionGrabs[0][0]];
    }
    
    
    findSong(searchstr) {
        var songs = this.filterSongsBySearchString(searchstr);
        if (songs.length) return songs[0];
        return null;
    }
    
    
    hashSong(hash) {
        return this._index[hash];
    }
    
    songPathByHash(hash) {
        return this.param('downloadPath') + '/' + hash + '.mp3';
    }

    
    getSongMeta(hash, field) {
        if (!this._index[hash]) return null;
        return this._index[hash][field];
    }
    
    setSongMeta(hash, field, value) {
        if (!this._index[hash]) return false;
        this._index[hash][field] = value;
        this.saveIndex();
        return true;
    }


    addSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        var ret = false;
        if (this._index[hash].keywords.indexOf(keyword) < 0) {
            this._index[hash].keywords.push(keyword);
            this.saveIndex();
            ret = true;
        }
        return ret;
    }
    
    removeSongKeyword(hash, keyword) {
        if (!this._index[hash]) return false;
        let ind = this._index[hash].keywords.indexOf(keyword);
        var ret = false;
        if (ind > -1) {
            this._index[hash].keywords.splice(ind, 1);
            this.saveIndex();
            ret = true;
        }
        return ret;
    }
    
    
    //Callback signature: messageObj, messageAuthor, reply, hash
    registerOnNewSong(func, self) {
        this.log('Registering new song callback. Context: ' + self.constructor.name);
        if (!self) {
            this._apiCbNewSong.push(func);
        } else {
            this._apiCbNewSong.push([func, self]);
        }
    }
    
    
    //Callback signature: messageObj, messageAuthor, reply, hash
    registerOnGrabscanExists(func, self) {
        this.log('Registering song found on scan callback. Context: ' + self.constructor.name);
        if (!self) {
            this._apiCbGrabscanExists.push(func);
        } else {
            this._apiCbGrabscanExists.push([func, self]);
        }
    }
    
    
    scanMessage(messageObj, callbacks, readOnly) {
        this._scanQueue.push([messageObj, callbacks, readOnly]);
    }
    

}


module.exports = ModGrabber;
