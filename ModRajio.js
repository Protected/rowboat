/* Module: Rajio -- Grabber add-on for playing songs on discord audio channels. */

const Module = require('./Module.js');
const moment = require('moment');
const random = require('meteor-random');
const fs = require('fs');
const emoji = require('emojione');

const PERM_ADMIN = 'administrator';
const PERM_MOD = 'moderator';


class ModRajio extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'grabber'               //Name of the ModGrabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get optionalParams() { return [
        'datafile',
        
        'channel',              //ID of a Discord audio channel to join by default
        'songrank',             //Name of the ModSongRank to obtain user preferences from
        'leadin',               //Length of silence, in seconds, before each new song is played
        'pause',                //Maximum amount of time in seconds to keep the current song paused when the module loses all listeners
        'autowithdraw',         //How long in seconds before a user withdraws from the queue if they are online but not a listener
        'queuesize',            //Maximum amount of songs in the request queue
        'historysize',          //Maximum amount of recently played songs to remember
        'referenceloudness',    //Negative decibels; Play youtube songs with higher loudness at a lower volume to compensate
        'volume',               //Global volume multipler; Defaults to 1.0 and can be changed via command
        
        'announcechannel',      //ID of a Discord text channel to announce rajio status information to
        'announcedelay',        //Minimum seconds between song announces
        'announcesongs',        //Announce when a song starts playing (true/false)
        'announcejoins',        //Announce when people start/stop listening (true/false)
        'announceskips',        //Announce skipped songs (true/false)

        'usestatus',            //Announce current song in bot's game (true/false)
        
        'pri.base',             //Base priority
        'pri.rank',             //Global song rank priority component
        'pri.listen',           //Unbiased listener rank priority component
        'pri.listen.slide',     //Weight of listener bias on rank, if applicable
        'pri.listen.history',   //Weight of history position bias on slide, if applicable
        'pri.length',           //Ideal length priority component
        'pri.length.minlen',    //(s) Minimum ideal song length
        'pri.length.maxlen',    //(s) Maximum ideal song length
        'pri.length.maxexcs',   //(s) Song length after which priority bonus is 0)
        'pri.lowplays',         //Low plays priority component
        'pri.lowplays.max',     //Maximum amount of plays to receive this bonus
        'pri.mitigatedslice',   //[0-1] Position of the plays-sorted library where priority multiplier is 1
        'pri.unanimous.meh',    //[0-1] Multiplier for priority if not all listeners hate the song, but all of them hate or dislike the song (<= -1)
        'pri.unanimous.hate',   //[0-1] Multiplier for priority if all listeners hate the song (-2)
        'pri.queue.chance',     //[0-1] Odds that only a queued song will not have 0 priority, if there are queued songs
        'pri.novelty.chance',   //[0-1] Odds that only a novelty will not have 0 priority, if there are novelties
        'pri.novelty.duration', //(s) For how long a new song is considered a novelty
        'pri.novelty.breaker',  //Maximum amount of plays above which a novelty is not treated as one, as a multiplier of the size of the library

    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('Rajio', name);
        
        this._params['datafile'] = null;
        
        this._params['channel'] = null;
        this._params['songrank'] = null;
        this._params['leadin'] = 2;
        this._params['pause'] = 900;
        this._params['autowithdraw'] = 120;
        this._params['queuesize'] = 10;
        this._params['historysize'] = 20;
        this._params['referenceloudness'] = -20;
        this._params['volume'] = 1.0;
        
        this._params['announcechannel'] = null;
        this._params['announcedelay'] = 0;
        this._params['announcesongs'] = true;
        this._params['announcejoins'] = true;
        this._params['announceskips'] = true;

        this._params['usestatus'] = true;

        /*
            LISTENER_SLIDE = Sum_[history](LISTENER_RANK * -1 * (maxhistory - HISTORY_POSITION) ^ pri.listen.history)

            SONG_PRIORITY =
                (
                    pri.base
                    + pri.rank * (GLOBAL_RANK / totalusers)
                    + pri.listen * (LISTENER_RANK / listenerusers)
                        * (LISTENER_SLIDE > 1 ? LISTENER_SLIDE ^ pri.listen.slide : 1)
                        * ...
                    + pri.length * OPTIMAL_LENGTH_GRADIENT[0, 1]
                    + pri.lowplays * (1 - Min(pri.lowplays.max, PLAYS) / pri.lowplays.max)
                )
                ^ (log(PLAYS_RANK + 1) / log(songcount * pri.mitigatedslice))
                * (unanimous_hate ? pri.unanimous.hate : (unanimous_dislike ? pri.unanimous.meh : 1))
        */

        this._params['pri.base'] = 10.0;
        this._params['pri.rank'] = 10.0;
        this._params['pri.listen'] = 30.0;
        this._params['pri.listen.slide'] = 0.5;
        this._params['pri.listen.history'] = 0.4;
        this._params['pri.length'] = 10.0;
        this._params['pri.length.minlen'] = 180;
        this._params['pri.length.maxlen'] = 600;
        this._params['pri.length.maxexcs'] = 900;
        this._params['pri.lowplays'] = 30.0;
        this._params['pri.lowplays.max'] = 3;
        this._params['pri.mitigatedslice'] = 0.1;
        this._params['pri.unanimous.meh'] = 0.65;
        this._params['pri.unanimous.hate'] = 0.05;

        /*
            If there are queued songs:
            SONG_PRIORITY = rand() < pri.queue.chance
                ? (isqueued ? (maxqueue - QUEUE_POSITION) / maxqueue : 0)
                : SONG_PRIORITY
        */

        this._params['pri.queue.chance'] = 0.9;

        /*
            If there are novelties (novelty is defined as: song shared less than pri.novelty.duration seconds ago and with less than pri.novelty.breaker * songcount plays)
            SONG_PRIORITY = rand() < pri.novelty.chance
                ? (isnovelty ? SONG_PRIORITY : 0)
                : SONG_PRIORITY
        */

        this._params['pri.novelty.chance'] = 0.05;
        this._params['pri.novelty.duration'] = 691200;  //8 days
        this._params['pri.novelty.breaker'] = 0.01;
        
        this._userdata = {};
        
        this._announced = null;
        this._history = [];  //[song, song, ...]
        this._playscache = {};  //{hash: plays, ...}
        
        this._queue = [];  //[{song, userid}, ...] - plays from the left
        this._lastreq = {};  //{hash: ts, ...} - When a requested song was last played (not persisted)
        this._disabled = false;
        this._volume = 1.0;
        
        this._pendingwithdraw = {};  //{userid: timer, ...} Autowithdrawal for non-listeners with queued songs
        this._skipper = {};  //{userid: true, ...} Requested skipping current song
        this._undeafen = {};  //{userid: true, ...} Users to undeafen as soon as they rejoin a voice channel
        this._nopreference = {};  //{userid: true, ...} Users have disabled impact of their preferences in priority calculations
        
        this._play = null;  //Song being played
        this._pending = null;  //Timer that will start the next song
        this._pause = null;  //[song, seek] for resuming paused song
        this._expirepause = null;  //Timer that will expire (stop) a paused song
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get songrank() {
        if (!this.param('songrank')) return null;
        return this.mod(this.param('songrank'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }
    
    get dchan() {
        return this.denv.server.channels.get(this._channel);
    }
    
    get listeners() {
        let me = this.denv.server.me;
        if (me.mute) return [];
        let dchan = this.dchan;
        if (!dchan) return [];
        return dchan.members.filter((member) => member.id != me.id && !member.deaf).array();
    }
    
    get playing() {
        return this.denv.server.voiceConnection && this.denv.server.voiceConnection.speaking || this._pending;
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') {
            this.log('error', "Grabber not found.");
            return false;
        }
        
        if (!this.denv || this.denv.envName != 'Discord') {
            this.log('error', "Environment not found or not Discord.");
            return false;
        }
        
        
        this._userdata = this.loadData();
        if (this._userdata === false) return false;
        
        
        this._channel = this.param('channel');
        this._volume = parseFloat(this.param('volume'));
        
        
        //Prepare player
        
        this.denv.on("connected", () => {
            this.joinDchan()
                .catch((reason) => {
                    this.log('Did not join voice channel on connect: ' + reason);
                })
        });
            
        
        
        //Register Discord callbacks

        var self = this;
        
        this.denv.client.on("voiceStateUpdate", (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            let myid = this.denv.server.me.id;
            let llisteners = this.listeners.length;
            let dchanid = null;
            if (this.dchan) dchanid = this.dchan.id;
            
            if (oldMember.voiceChannelID != dchanid && member.voiceChannelID == dchanid) {
                if (member.id == myid) {
                    if (llisteners) {
                        //I joined the channel
                        this.resumeSong() || this.playSong();
                    }
                } else {
                    if (this._skipper[member.id] && !member.deaf) {
                        //Skipper tried to undeafen themselves... Nah
                        member.setDeaf(true);
                    } else {

                        if (this.param('announcejoins')) {
                            this.announce('__Arrived__: ' + this.denv.idToDisplayName(member.id));
                        }

                        if (this._undeafen[member.id]) {
                            member.setDeaf(false);
                            delete this._undeafen[member.id];
                        }
                        if (!member.deaf) {
                            if (!this.playing) {
                                //First listener joined the channel
                                this.joinDchan()
                                    .catch((reason) => {
                                        this.log('Did not join voice channel on first listener: ' + reason);
                                    })
                            }
                            this.stayafterall(member.id);
                        }
                    }
                }
            }
            
            if (oldMember.voiceChannelID == dchanid && member.voiceChannelID != dchanid) {
                if (member.id == myid) {
                    //I left the channel
                    if (!this._pause) this.stopSong();
                } else {

                    if (this.param('announcejoins')) {
                        this.announce('__Departed__: ' + this.denv.idToDisplayName(member.id));
                    }

                    this.autowithdraw(member.id);
                    if (this._nopreference[member.id]) delete this._nopreference[member.id];
                    if (!llisteners) {
                        //Last listener left the channel
                        this.pauseSong();
                        this.dchan.leave();
                    }
                }
            }
            
            if (member.id == myid) {
                if (!oldMember.mute && member.mute) {
                    //I was muted
                    this.pauseSong();
                }
                if (oldMember.mute && !member.mute) {
                    //I was unmuted
                    this.resumeSong() || this.playSong();
                }
            } else {
                if (!oldMember.deaf && member.deaf) {
                    if (!llisteners) {
                        //Last listener was deafened
                        this.pauseSong();
                        this.dchan.leave();
                    }
                } else if (oldMember.deaf && !member.deaf) {
                    if (this._skipper[member.id] && member.voiceChannelID == dchanid) {
                        //Skipper tried to undeafen themselves... Nah
                        member.setDeaf(true);
                    } else if (llisteners == 1) {
                        //First listener was undeafened
                        this.joinDchan()
                            .catch((reason) => {
                                this.log('Did not join voice channel on first listener: ' + reason);
                            })
                    }
                }
            }
            
        });
        
        
        this.denv.client.on('presenceUpdate', (oldMember, member) => {
            if (member.guild.id != this.denv.server.id) return;
            
            if (oldMember.user.presence.status != "offline" && member.user.presence.status == "offline") {
                this.withdraw(member.user.id);
            }
        });
        
        this.denv.client.on("guildMemberRemove", (member) => {
            if (member.user.presence.status == "offline") return;
            if (member.guild.id != this.denv.server.id) return;
            this.withdraw(member.user.id);
        });
        
        
        //Register module integrations
        
        this.grabber.registerParserFilter(/^[$]([0-9]+)?$/, (str, match, userid) => {
            if ((!match[1] || match[1] == "0") && this._play) return this._play.hash;
            if (match[1] && this._history[match[1] - 1]) {
                return this._history[match[1] - 1].hash;
            }
            return null;
        }, this);
        

        //Register commands

        this.mod("Commands").registerRootDetails(this, 'rajio', {
            description: 'Commands for controlling the radio queue and playback.',
            details: [
                'This feature adds the $NUMBER expansion to song library hash arguments, representing the currently playing song or a recently played song.'
            ]
        });

        this.mod('Commands').registerCommand(this, 'rajio now', {
            description: 'Displays the name and hash of the song currently being played.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is disabled.');
                return true;
            }
        
            if (!this._play) {
                if (this._pause) {
                    ep.reply('**[Paused]** ' + '`' + this._pause[0].hash + ' ' + this._pause[0].name + (this._pause[0].author ? ' (' + this._pause[0].author + ')' : '')
                        + ' <' + this.secondsToHms(Math.round(this._pause[1] / 1000.0)) + ' / ' + this.secondsToHms(this._pause[0].length) + '>`');
                } else {
                    ep.reply('Nothing is being played right now.');
                }
            } else {
                let vc = this.denv.server.voiceConnection;
                ep.reply('**[Playing]** ' + '`' + this._play.hash + ' ' + this._play.name + (this._play.author ? ' (' + this._play.author + ')' : '')
                    + ' <' + (vc && vc.dispatcher ? this.secondsToHms(Math.round(vc.dispatcher.time / 1000.0)) + ' / ' : '') + this.secondsToHms(this._play.length) + '>`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio skip', {
            description: 'Vote to skip the current song.',
            details: [
                "When a listener calls this command, if there are no listeners who haven't called it, the current song is skipped.",
                "Otherwise, the listener is deafened until the end of the song and a beep is played in the channel to alert other listeners.",
                "If the listener leaves the channel or undeafens himself, his skip vote is revoked."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.playing || this._skipper[userid] || !this.islistener(userid)) return true;
            
            let listeners = this.listeners;
            
            let cskippers = Object.keys(this._skipper).length;
            let clisteners = listeners.length;
            
            for (let skipperid in this._skipper) {
                if (!listeners.find((item) => item.id == skipperid)) {
                    clisteners += 1;
                }
            }
            
            ep.reply('OK (' + (cskippers+1) + '/' + clisteners + ').');
            
            this._skipper[userid] = true;
            
            if (cskippers >= clisteners - 1) {
                let prefix = "rajio." + this.name.toLowerCase();
                let skipdata = this.grabber.getSongMeta(this._play.hash, prefix + ".skipped");
                if (!skipdata) skipdata = {};
                
                let now = moment().unix();
                skipdata[now] = Object.keys(this._skipper);
                this.grabber.setSongMeta(this._play.hash, prefix + ".skipped", skipdata);

                let song = this._play;

                this.stopSong();

                if (this.param('announceskips')) {
                    this.announce('**[Skipped]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
                }

                this.playSong();
                return true;
            }
                        
            this.dchan.members.get(userid).setDeaf(true);
            
            let vc = this.denv.server.voiceConnection;
            //vc.playFile('beep.ogg');
        
            return true;
        });
        

        this.mod('Commands').registerCommand(this, 'rajio off', {
            description: 'Disable the radio. This will stop it from playing music.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is already disabled.');
                return true;
            }
            
            this._disabled = true;
            this.stopSong();
            
            if (this.dchan) {
                this.dchan.leave();
            }
            
            ep.reply('The radio has now been disabled.');

            return true;
        });

        
        this.mod('Commands').registerCommand(this, 'rajio on', {
            description: 'Enable or re-enable the radio in an existing voice channel.',
            args: ['channelid'],
            minArgs: 0,
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._disabled) {
                ep.reply('The radio is already enabled!');
                return true;
            }

            if (args.channelid) {
                let newchan = this.denv.server.channels.get(args.channelid);
                if (!newchan || newchan.type != "voice") {
                    ep.reply('There is no voice channel with the specified ID.');
                    return true;
                }
                this._channel = args.channelid;
            } else {
                let me = this.denv.server.members.get(userid);
                if (me && me.voiceChannelID) {
                    this._channel = me.voiceChannelID;
                }
            }
            
            if (!this.dchan || this.dchan.type != "voice") {
                ep.reply("The voice channel could not be found. Please specify the ID of an existing voice channel.");
                return true;
            }
            
            this._disabled = false;

            this.joinDchan()
                .then(() => {
                    ep.reply('The radio has now been enabled.');
                })
                .catch((reason) => {
                    ep.reply('The radio has now been enabled.');
                    this.log('Did not join voice channel on enable: ' + reason);
                });
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio volume', {
            description: 'Adjust the master volume attenuation.',
            args: ['volume'],
            details: [
                "Use a value between 0.0 (no sound) and 1.0 (maximum)."
            ],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let volume = parseFloat(args.volume);
            if (isNaN(volume) || volume < 0 || volume > 1) {
                ep.reply('Please specify a number between 0.0 and 1.0 .');
                return true;
            }
            
            this._volume = volume;
            ep.reply('OK.');
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio another', {
            description: 'End playback of the current song and play the next one in the queue.',
            permissions: [PERM_ADMIN, PERM_MOD]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) return true;
        
            this.stopSong();
            this.playSong();
        
            return true;
        });
        
        
        let requestcommand = (demand) => (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            if (args.hashoroffset.length > 1 && !arg.match(/^\(.*\)$/)) {
                arg = '(' + arg + ')';
            }
        
            let hash = this.grabber.bestSongForHashArg(arg, userid);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
            
            let song = this.grabber.hashSong(hash);
            if (!this.enqueue(song, userid, demand)) {
                ep.reply('The queue is full or the song is already in the queue.');
                return true;
            }
            
            if (!this.islistener(userid)) {
                this.autowithdraw(userid);
            }
            
            ep.reply('OK.');
        
            return true;
        }
        
        this.mod('Commands').registerCommand(this, 'rajio request', {
            description: 'Requests playback of a song in the library, which will be added to the queue if possible.',
            args: ['hashoroffset', true]
        }, requestcommand(false));
        
        this.mod('Commands').registerCommand(this, 'rajio demand', {
            description: 'Puts a song from the library at the top of the queue.',
            args: ['hashoroffset', true],
            permissions: [PERM_ADMIN, PERM_MOD]
        }, requestcommand(true));
        
        
        this.mod('Commands').registerCommand(this, 'rajio withdraw', {
            description: 'Withdraws all your requests from the queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let result = this.withdraw(userid);
            if (result) {
                ep.reply('Removed your ' + (result > 1 ? result + ' requests' : 'request') + ' from the queue.');
            } else {
                ep.reply('You made no requests!');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio queue', {
            description: 'Show a summary of the contents of the queue.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }

            if (!this._queue.length) {
                ep.reply('The queue is empty.');
                return true;
            }
        
            for (let i = 0; i < this._queue.length; i++) {
                let song = this._queue[i].song;
                let width = String(this.param('queuesize')).length;        //
                let pos = ('0'.repeat(width) + String(i+1)).slice(-width); //0-padded i
                ep.reply('`[' + pos + '] ' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio history', {
            description: 'Show a list of recently played songs.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._history.length) {
                ep.reply('No songs were played.');
                return true;
            }

            for (let i = 0; i < this._history.length; i++) {
                let song = this._history[i];
                if (!song) continue;
                let width = String(this.param('historysize')).length;        //
                let pos = ('0'.repeat(width) + String(i+1)).slice(-width);   //0-padded i
                ep.reply('`[$' + pos + '] ' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio neutral', {
            description: 'Toggle whether my likes and priorities will affect song selection while I\'m listening.'
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }
        
            if (this._nopreference[userid]) {
                delete this._nopreference[userid];
                ep.reply('Disabled neutral mode: Re-enabled the use of your preferences in song selection.');
            } else {
                this._nopreference[userid] = true;
                ep.reply('Enabled neutral mode: Your preferences will no longer be used in song selection until the end this session. You can also repeat this command to return to normal.');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio apriority', {
            description: 'Analyze a song\'s current priority value.',
            args: ['hashoroffset', true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            
            let hash = this.grabber.bestSongForHashArg(arg);
            if (hash === false) {
                ep.reply('Offset not found in recent history.');
                return true;
            } else if (hash === true) {
                ep.reply('Reference matches more than one song; Please be more specific.');
                return true;
            } else if (!hash) {
                ep.reply('Hash not found.');
                return true;
            }
            
            let prioritycomponents = this.songPriority(this.grabber.hashSong(hash), this.listeners.map((listener) => listener.id), false, false, true);
            
            for (let cname in prioritycomponents) {
                ep.reply('`' + cname + ' = ' + prioritycomponents[cname] + '`');
            }

            let queuepos = this._queue.findIndex((item) => item.song.hash == hash);
            if (queuepos > -1) {
                ep.reply('`Queued in position ' + queuepos + ' .`');
            }

            if (this.isNovelty(hash)) {
                ep.reply('`This song can play as a novelty.`');
            }

            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    

    //Discord stuff

    announce(msg) {
        if (!this.param('announcechannel')) return false;
        this.denv.msg(this.param('announcechannel'), msg);
        return true;
    }


    joinDchan() {
        if (this._disabled) return Promise.reject("Rajio is disabled.");
        if (!this.listeners.length) return Promise.reject("No listeners.");
        if (!this.dchan || this.dchan.type != "voice") return Promise.reject("Voice channel not found.");
        return this.dchan.join()
            .catch((reason) => {
                this.log("error", "Error connecting to voice channel: " + reason)
            });
    }

    
    //Internal playback control
    
    playSong(song, seek) {
        let vc = this.denv.server.voiceConnection;
        if (!vc || vc.speaking || this._pending
                || this.denv.server.me.mute || !this.listeners.length || this._disabled) {
            return false;
        }
        
        let userid = null;
        if (!song) {
            song = this.dequeue(true);
            if (!song) return false;
            userid = song[1];
            song = song[0];
        }
        
        if (!song || !song.hash) return false;
        
        this.log('Playing song: ' + song.hash);
        
        if (this.param('announcesongs') && (!this._announced || moment().unix() > this._announced + this.param('announcedelay'))) {
            let reqby = '';
            if (userid) {
                reqby = ' ** Requested by __' + this.denv.idToDisplayName(userid) + '__';
            }

            //This block is for displaying likes in the announcement channel
            let likespart = '';
            let songrank = this.songrank;
            if (songrank) {
                let likes = songrank.getAllSongLikes(song.hash);
                if (Object.keys(likes).length > 0) {
                    let listeners = this.listeners.map((member) => member.id);
                    let listenerlikes = [];
                    let otherlikes = [];    
                    let icons = songrank.likeabilityIcons;
                    for (let userid in likes) {
                        let icon = icons[likes[userid]];
                        if (!icon) continue;
                        if (listeners.indexOf(userid) > -1) {
                            listenerlikes.push(':' + icon + ':');
                        } else {
                            otherlikes.push(':' + icon + ':');
                        }
                    }
                    if (listenerlikes.length > 8) {
                        listenerlikes = listenerlikes.reduce((acc, value) => acc[value] = (acc[value] ? acc[value] + 1 : 1), {});
                        likespart += ' **[**';
                        for (icon in listenerlikes) {
                            likespart += listenerlikes[icon] + 'x' + emoji.shortnameToUnicode(icon) + ' ';
                        }
                        likespart = likespart.trimRight() + '**]** ';
                    } else if (listenerlikes.length) {
                        likespart += ' **[**' + emoji.shortnameToUnicode(listenerlikes.join(' ')) + '**]** ';
                    }
                    if (otherlikes.length > 8) {
                        otherlikes = otherlikes.reduce((acc, value) => acc[value] = (acc[value] ? acc[value] + 1 : 1), {});
                        for (icon in otherlikes) {
                            likespart += otherlikes[icon] + 'x' + emoji.shortnameToUnicode(icon) + ' ';
                        }
                    } else if (otherlikes.length) {
                        likespart += emoji.shortnameToUnicode(otherlikes.join(' '));
                    }
                }
            }

            this.announce('**[' + (seek ? 'Resuming' : 'Now Playing') + ']** ' + '`' + song.hash
                    + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + ' <' + this.secondsToHms(song.length) + '>`' + likespart + reqby);
            this._announced = moment().unix();
        }
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity(song.name + (song.author ? " (" + song.author + ")" : ""), {type: 'PLAYING'}).catch(() => {});
        }
        
        let att = 1.0;
        let ref = this.param('referenceloudness');
        if (!isNaN(ref) && ref < 0) {
            if (song.sourceLoudness && song.sourceLoudness > ref) {  //Both negative numbers
                att = Math.pow(10, (ref - song.sourceLoudness) / 20);
            }
        }
        
        let options = {
            volume: this._volume * att,
            seek: (seek ? Math.round(seek / 1000.0) : 0)
        };
        
        this.grabber.setAdditionalStats('rajio.' + this.name.toLowerCase() + '.playing', song.hash);
        this._play = song;
        this._pending = setTimeout(() => {
        
            this.abortskip();
            
            let ender = () => {
                if (this._play) {
                    this.remember(this._play);
                }
                if (!this._pause) {
                    this.playSong();
                }
            };
            
            if (song.format == 'pcm') {
                vc.playConvertedStream(fs.createReadStream(this.grabber.songPathByHash(song.hash)), options).once("end", ender);
            } else {
                vc.playFile(this.grabber.songPathByHash(song.hash), options).once("end", ender);
            }
            
            this._pending = null;
        }, this.param('leadin') > 0 ? this.param('leadin') * 1000 : 1);
        
        return true;
    }
    
    stopSong() {
        let vc = this.denv.server.voiceConnection;
        
        this.log('Stopping song' + (this._play ? ': ' + this._play.hash : '.'));
        this.grabber.setAdditionalStats('rajio.' + this.name.toLowerCase() + '.playing', null);
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity(null).catch(() => {});
        }
        
        if (this._pending) {
            clearTimeout(this._pending);
            this._pending = null;
        }
        
        if (this._expirepause) {
            clearTimeout(this._expirepause);
            this._expirepause = null;
        }
        
        if (vc && vc.dispatcher) {
            this._play = null;
            this._pause = true;  //Hack to stop the end event from playing next song
            vc.dispatcher.end();
        }
        
        this._pause = null;
        
        this.abortskip();
    }
    
    pauseSong() {
        let vc = this.denv.server.voiceConnection;
        if (!vc || !vc.speaking || !vc.dispatcher) {
            return this.stopSong();
        }
        
        this.log('Pausing song: ' + this._play.hash + ' at ' + vc.dispatcher.time);
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity("*Paused*", {type: 'PLAYING'}).catch(() => {});
        }
        
        this._pause = [this._play, vc.dispatcher.time];
        this._play = null;
        vc.dispatcher.end();
        
        this._expirepause = setTimeout(() => {
            this.log('Expiring paused song: ' + this._pause[0].hash);
            this.stopSong();
            this._expirepause = null;
        }, this.param('pause') > 0 ? this.param('pause') * 1000 : 1);
    }
    
    resumeSong() {
        if (!this._pause) return false;
        
        this.log('Preparing to resume song: ' + this._pause[0].hash + ' at ' + this._pause[1]);
        
        let song = this._pause[0];
        let seek = this._pause[1];
        
        this._pause = null;
        
        this.playSong(song, seek);
        
        if (this._expirepause) {
            clearTimeout(this._expirepause);
            this._expirepause = null;
        }
        
        return true;
    }
    
    
    //Control the queue of pending/upcoming songs
    
    enqueue(song, userid, demand) {
        if (!song) return false;
        if (this._queue.find((item) => item.song.hash == song.hash)) return false;
        
        if (demand) {
            this._queue.unshift({
                song: song,
                userid: userid
            });
            this._queue = this._queue.slice(0, this.param('queuesize'));
            return true;
        }
        
        let countbyuser = {};
        let max = 0;
        for (let item of this._queue) {
            if (!countbyuser[item.userid]) {
                countbyuser[item.userid] = 1;
                max = Math.max(max, 1);
            } else {
                countbyuser[item.userid] += 1;
                max = Math.max(max, countbyuser[item.userid]);
            }
        }
        
        let newitem = {
            song: song,
            userid: userid
        };
        
        if (!max || countbyuser[userid] >= max) {
            if (this._queue.length >= this.param('queuesize')) return false;
            this._queue.push(newitem);
        } else {
            this._queue.splice(((countbyuser[userid] || 0) + 1) * Object.keys(countbyuser).length, 0, newitem);
            this._queue = this._queue.slice(0, this.param('queuesize'));
        }
        
        return true;
    }
    
    dequeue(getrequester) {
        let listeners = this.listeners.map((listener) => listener.id);
    
        let usequeue = (this._queue.length ? random.fraction() < this.param('pri.queue.chance') : false);
        let usenovelty = (this.isThereANovelty() ? random.fraction() < this.param('pri.novelty.chance') : false);

        let priorities = {};
        for (let hash of this.grabber.everySong()) {
            let priority = this.songPriority(this.grabber.hashSong(hash), listeners, usequeue, usenovelty);
            priorities[hash] = priority;
        }

        this.grabber.setAdditionalStats('rajio.' + this.name.toLowerCase() + '.latestpriorities', priorities);
        
        let sum = 0;
        let candidates = [];
        for (let hash in priorities) {
            if (!priorities[hash]) continue;
            sum += priorities[hash];
            candidates.push([hash, sum]);
        }
        
        if (!candidates.length) return null;
        
        let pick = random.fraction() * sum;
        let selection = null;
        for (let item of candidates) {
            selection = item;
            if (pick < item[1]) break;
        }
        if (!selection) selection = candidates[candidates.length - 1];
        
        let hash = selection[0];
        
        let index = this._queue.findIndex((item) => item.song.hash == hash);
        let userid = null;
        if (index > -1) {
            userid = this._queue[index].userid;
            this._lastreq[hash] = moment().unix();
            this._queue.splice(index, 1);
        }
        
        if (getrequester) {
            return [this.grabber.hashSong(hash), userid];
        }
        
        return this.grabber.hashSong(hash);
    }
    
    withdraw(userid, fromauto) {
        let newqueue = this._queue.filter((item) => item.userid != userid);
        let result = 0;
        if (newqueue.length != this._queue.length) {
            result = this._queue.length - newqueue.length;
            this.log('User ' + userid + ' withdrew from the queue. Removed ' + result + ' song(s).');
            this._queue = newqueue;
        }
        if (!fromauto && this._pendingwithdraw[userid]) {
            clearTimeout(this._pendingwithdraw[userid]);
            this._pendingwithdraw[userid] = null;
        }
        return result;
    }
    
    autowithdraw(userid) {
        if (this._pendingwithdraw[userid]) return;
        this._pendingwithdraw[userid] = setTimeout(() => {
            this.withdraw(userid, true);
            this._pendingwithdraw[userid] = null;
        }, this.param('autowithdraw') * 1000);
    }
    
    stayafterall(userid) {
        if (!this._pendingwithdraw[userid]) return;
        clearTimeout(this._pendingwithdraw[userid]);
        this._pendingwithdraw[userid] = null;
    }
    
    
    //Abort request to skip current song
    
    abortskip() {
        if (this.dchan) {
            let members = this.dchan.members;
            for (let userid in this._skipper) {
                if (members.get(userid) && members.get(userid).deaf) {
                    members.get(userid).setDeaf(false);
                    delete this._skipper[userid];
                }
            }
        }
        for (let userid in this._skipper) {
            this._undeafen[userid] = true;
        }
        this._skipper = {};
    }
    
    
    //Remember played song
    
    remember(song) {
        this._history.unshift(song);
        if (this._history.length > this.param('historysize')) {
            this._history = this._history.slice(0, this.param('historysize'));
        }
        
        let prefix = "rajio." + this.name.toLowerCase();
        let plays = (this.grabber.getSongMeta(song.hash, prefix + ".plays") || 0) + 1;
        this.grabber.setSongMeta(song.hash, prefix + ".lastplayed", moment().unix());
        this.grabber.setSongMeta(song.hash, prefix + ".plays", plays);
        this.grabber.setSongMeta(song.hash, prefix + ".skipped", null);
        this._playscache[song.hash] = plays;
    }
    
    
    //Auxiliary
    
    islistener(userid) {
        if (!this.dchan) return false;
        let member = this.dchan.members.get(userid);
        return member && !member.deaf;
    }
    
    
    secondsToHms(seconds) {
        let h = Math.floor(seconds / 3600.0);
        seconds = seconds % 3600;
        let m = Math.floor(seconds / 60.0);
        seconds = seconds % 60;
        let result = ('0' + seconds).slice(-2);
        result = ('0' + m).slice(-2) + ':' + result;
        if (h) result = ('0' + h).slice(-2) + ':' + result;
        return result;
    }
    
    
    unanimousOpinion(hash, listeners, likeability) {
        if (!this.songrank) return false;
        for (let listener of listeners) {
            let listenerlik = this.songrank.getSongLikeability(hash, listener);
            if (listenerlik === null || listenerlik === undefined || likeability > 0 && listenerlik < likeability || likeability < 0 && listenerlik > likeability) {
                return false;
            }
        }
        return true;
    }

    calculateListenerSlide(listener) {
        if (!this.songrank) return 0;
        let slide = 0;
        for (let i = 0; i < this._history.length; i++) {
            let song = this._history[i];
            let comp = (this.songrank.computeSongRank(song.hash, [listener]) || 0);
            if (comp <= 0) comp -= 0.5;
            comp *= -1 * Math.pow(this._history.length - i, this.param('pri.listen.history'));
            slide += comp;
        }
        return slide;
    }

    playsRank(hash) {
        let prefix = "rajio." + this.name.toLowerCase();
        let songs = this.grabber.everySong();
        if (Object.keys(this._playscache).length != songs.length) {
            for (let songhash of songs) {
                if (!this._playscache[songhash]) {
                    this._playscache[songhash] = (this.grabber.getSongMeta(songhash, prefix + ".plays") || 0);
                }
            }
        }
        let rank = 0;
        let plays = this._playscache[hash];
        for (let songhash in this._playscache) {
            if (this._playscache[songhash] > plays) {
                rank += 1;
            }
        }
        return rank;
    }

    isNovelty(hash, songcount) {
        if (!songcount) songcount = this.grabber.everySong().length;
        let seen = this.grabber.getSongMeta(hash, "seen");
        if (!seen || moment().unix() - seen[0] > this.param('pri.novelty.duration')) return false;
        if (this.grabber.getSongMeta(hash, "plays") > songcount * this.param("pri.novelty.breaker")) return false;
        return true;
    }

    isThereANovelty() {
        let everysong = this.grabber.everySong();
        for (let hash of everysong) {
            if (this.isNovelty(hash, everysong.length)) {
                return true;
            }
        }
        return false;
    }

    
    songPriority(song, listeners, usequeue, usenovelty, trace) {
        let prefix = "rajio." + this.name.toLowerCase();
        let priority = this.param('pri.base');
        let components = {base: priority};
        let songcount = this.grabber.everySong().length;
        
        let prelisteners = (listeners || []);
        listeners = [];
        for (let userid of prelisteners) {
            if (this._nopreference[userid]) continue;
            listeners.push(userid);
        }
        
        
        //Rank-based components
        
        let songrank = this.songrank;
        
        if (songrank) {
            let calcrank = songrank.computeSongRank(song.hash, null, true);
            let crank = (calcrank.rank || 0);
            if (calcrank.users.length) crank /= calcrank.users.length;
            crank *= this.param('pri.rank');
            priority += crank;
            if (trace) components.rank = crank;
            
            if (listeners.length) {
                let clisten = (songrank.computeSongRank(song.hash, listeners) || 0) / listeners.length * this.param('pri.listen');
                if (trace) components.prelisten = clisten;

                for (let listener of listeners) {
                    let slide = this.calculateListenerSlide(listener);
                    if (trace) components["slide." + listener] = slide;
                    clisten *= (slide > 1 ? Math.pow(slide, this.param('pri.listen.slide')) : 1);
                }

                priority += clisten;
                if (trace) components.listen = clisten;
            }
        }
                
        
        //Proximity to optimal length
        
        let clength = 0;
        if (song.length >= this.param('pri.length.minlen') && song.length <= this.param('pri.length.maxlen')) {
            clength = this.param('pri.length');
        } else if (song.length > this.param('pri.length.maxlen') && song.length < this.param('pri.length.maxexcs')) {
            clength = this.param('pri.length') * ((this.param('pri.length.maxexcs') - song.length) / (this.param('pri.length.maxexcs') - this.param('pri.length.maxlen')));
        } else if (song.length < this.param('pri.length.minlen')) {
            clength = this.param('pri.length') * (song.length / this.param('pri.length.minlen'));
        }
        priority += clength;
        if (trace) components.length = clength;


        //Low plays
        
        let plays = song[prefix + ".plays"] || 0;
        let clowplays = (1 - Math.min(this.param('pri.lowplays.max'), plays) / this.param('pri.lowplays.max')) * this.param('pri.lowplays');
        priority += clowplays;
        if (trace) components.lowplays = clowplays;


        //Comparative plays

        if (trace) components.baseabsolute = priority;
        let playsrank = this.playsRank(song.hash);
        let playsfactor = Math.log(playsrank + 1) / Math.log(1 + songcount * this.param('pri.mitigatedslice'));
        if (trace) components.playsfactor = playsfactor;
        priority = Math.pow(priority, playsfactor);
        if (trace) components.withplays = priority;


        //Unanimous dislike penalties
        
        if (listeners.length) {
            let upenalty = null;
            if (this.unanimousOpinion(song.hash, listeners, -2)) {
                upenalty = priority * (1 - this.param('pri.unanimous.hate'));
                priority -= upenalty;
                if (trace) components.unanimoushate = upenalty;
            } else if (this.unanimousOpinion(song.hash, listeners, -1)) {
                upenalty = priority * (1 - this.param('pri.unanimous.meh'));
                priority -= upenalty;
                if (trace) components.unanimousdislike = upenalty;
            }
        }


        //Queue

        if (usequeue && this._queue.length) {
            let queuepos = this._queue.findIndex((item) => item.song.hash == song.hash);
            if (queuepos > -1) {
                priority = (this.param('queuesize') - queuepos) / this.param('queuesize');
                if (trace) components.queuereset = priority;
            } else {
                priority = 0;
                if (trace) components.queuereset = priority;
            }

        }


        //Novelty

        if (usenovelty && !this.isNovelty(song.hash, songcount)) {
            priority = 0;
            if (trace) components.noveltyreset = priority;
        }


        if (trace) {
            components.priority = priority;
            return components;
        }
        
        return priority;
    }
    
    
}


module.exports = ModRajio;
