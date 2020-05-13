/* Module: Rajio -- Grabber add-on for playing songs on discord audio channels. */

const Module = require('../Module.js');
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
        'referenceloudness',    //Negative decibels; Play youtube songs with higher loudness at a lower volume to compensate (non-normalized entries only)
        'volume',               //Global volume multipler; Defaults to 1.0 and can be changed via command
        'fec',                  //Forward error correction (true/false)
        
        'announcechannel',      //ID of a Discord text channel to announce rajio status information to
        'announcedelay',        //Minimum seconds between song announces
        'announcesongs',        //Announce when a song starts playing (true/false)
        'announcejoins',        //Announce when people start/stop listening (true/false)
        'announceskips',        //Announce skipped songs (true/false)

        'usestatus',            //Announce current song in bot's game (true/false)
        
        'pri.base',             //Base priority
        'pri.rank',             //Global song rank priority component
        'pri.listen',           //Unbiased listener rank priority component
        'pri.listen.nopos',     //Attenuate listener priority for songs with no positive preference keywords associated
        'pri.listen.yesneg',    //Attenuate listener priority for songs with negative preference keywords associated
        'pri.listen.skiprange', //(s) For how long after a song last skipped its positive listener rank is mitigated
        'pri.listen.skipbias',  //Exponent/bias for skip mitigation (1 will make it linear, otherwise weight towards early or late in period)
        'pri.listen.skipfact',  //Minimum (most impactful) coefficient applied by skipping (if song was just skipped)
        'pri.listen.slide',     //Weight of listener bias on rank, if applicable
        'pri.listen.history',   //Weight of history position bias on slide, if applicable
        'pri.listen.historysc', //Multiplier for history position bias
        'pri.length',           //Ideal length priority component
        'pri.length.minlen',    //(s) Minimum ideal song length
        'pri.length.maxlen',    //(s) Maximum ideal song length
        'pri.length.maxexcs',   //(s) Song length after which priority bonus is 0)
        'pri.lowplays',         //Low plays priority component
        'pri.lowplays.max',     //Maximum amount of plays to receive this bonus
        'pri.mitigatedslice',   //[0-1] Position of the plays-sorted library where priority multiplier is 1
        'pri.recent',           //(s) For how long after a song last played its priority is mitigated (on a linear gradient)
        'pri.unanimous.meh',    //[0-1] Multiplier for priority if not all listeners hate the song, but all of them hate or dislike the song (<= -1)
        'pri.unanimous.hate',   //[0-1] Multiplier for priority if all listeners hate the song (-2)
        'pri.queue.chance',     //[0-1] Odds that only a queued song will not have 0 priority, if there are queued songs
        'pri.novelty.chance',   //[0-1] Odds that only a novelty will not have 0 priority, if there are novelties
        'pri.novelty.duration', //(s) For how long a new song is considered a novelty
        'pri.novelty.breaker',  //Maximum amount of plays above which a novelty is not treated as one

        'pref.maxcurators',     //Maximum amount of curators per player
        'pref.maxkeywords',     //Maximum amount of keywords per player

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
        this._params['fec'] = false;
        
        this._params['announcechannel'] = null;
        this._params['announcedelay'] = 0;
        this._params['announcesongs'] = true;
        this._params['announcejoins'] = true;
        this._params['announceskips'] = true;

        this._params['usestatus'] = true;

        /*
            LISTENER_CURATORS_RANK = Sum_[curator](-1? * CURATOR_RANK)/curators

            KWPREF_FACTOR: If "+" exist and none present, * pri.listen.nopos ; If "-" exist and present, * pri.listen.yesneg

            SKIP_FACTOR: If listener rank is positive but listener skipped song in last pri.listen.skiprange seconds,
                        (ELAPSED_TIME / pri.listen.skiprange) ^ pri.listen.skipbias * (1-pri.listen.skipfact) + pri.listen.skipfact, otherwise 1

            LISTENER_SLIDE = Sum_[history](LISTENER_RANK * -1 * ((maxhistory - HISTORY_POSITION) * pri.listen.historysc) ^ pri.listen.history)

            SONG_PRIORITY =
                (
                    pri.base
                    + pri.rank * (GLOBAL_RANK / totalusers)
                    + pri.listen * (
                            LISTENER_CURATORS_RANK / listenerusers * KWPREF_FACTOR * SKIP_FACTOR
                            + ...
                        )
                        * (LISTENER_SLIDE > 1 ? LISTENER_SLIDE ^ pri.listen.slide : 1)
                        * ...
                    + pri.length * OPTIMAL_LENGTH_GRADIENT[0, 1]
                    + pri.lowplays * (1 - Min(pri.lowplays.max, PLAYS) / pri.lowplays.max)
                )
                ^ (log(PLAYS_RANK + 1) / log(songcount * pri.mitigatedslice))
                * RECENT_GRADIENT[0, 1]
                * (unanimous_hate ? pri.unanimous.hate : (unanimous_dislike ? pri.unanimous.meh : 1))
        */

        this._params['pri.base'] = 10.0;
        this._params['pri.rank'] = 10.0;
        this._params['pri.listen'] = 50.0;
        this._params['pri.listen.nopos'] = 0.75;
        this._params['pri.listen.yesneg'] = 0.10;
        this._params['pri.listen.skiprange'] = 259200;
        this._params['pri.listen.skipbias'] = 2;
        this._params['pri.listen.skipfact'] = 0.1;
        this._params['pri.listen.slide'] = 0.5;
        this._params['pri.listen.history'] = 0.3;
        this._params['pri.listen.historysc'] = 3;
        this._params['pri.length'] = 10.0;
        this._params['pri.length.minlen'] = 180;
        this._params['pri.length.maxlen'] = 600;
        this._params['pri.length.maxexcs'] = 900;
        this._params['pri.lowplays'] = 30.0;
        this._params['pri.lowplays.max'] = 3;
        this._params['pri.mitigatedslice'] = 0.1;
        this._params['pri.recent'] = 86400;
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
            If there are novelties (novelty is defined as: song shared less than pri.novelty.duration seconds ago and with less than pri.novelty.breaker plays)
            SONG_PRIORITY = rand() < pri.novelty.chance
                ? (isnovelty ? SONG_PRIORITY : 0)
                : SONG_PRIORITY
        */

        this._params['pri.novelty.chance'] = 0.05;
        this._params['pri.novelty.duration'] = 691200;  //8 days
        this._params['pri.novelty.breaker'] = 8;

        this._params['pref.maxcurators'] = 3;
        this._params['pref.maxkeywords'] = 8;
        
        this._userdata = {};  // {userid: {curators: {userid: boolean, ...}, keywords: {keyword: rating, ...}, saved: {profilename: {...}}}}
        
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
        this._userlistened = {};  //{userid: songs, ...} Amount of songs each user has listened to in current listening session
        this._userremaining = {};  //{userid: songs, ...} Amount of songs before a user will be automatically disconnected
        
        this._play = null;  //Song being played
        this._seek = 0;  //Starting time of the song being played, for time calculation purposes
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
        return this.denv.server.channels.cache.get(this._channel);
    }
    
    get vc() {
        let voice = this.denv.server.voice;
        if (!voice) return null;
        return this.denv.server.voice.connection;
    }
    
    get listeners() {
        let me = this.denv.server.me;
        if (me.voice.mute) return [];
        let dchan = this.dchan;
        if (!dchan) return [];
        return dchan.members.filter((member) => member.id != me.id && !member.voice.deaf).array();
    }
    
    get playing() {
        return this.vc && this.vc.dispatcher || this._pending;
    }
    
    get strictlyPlaying() {
        return this.vc && this.vc.dispatcher;
    }

    get metaprefix() {
        return 'rajio.' + this.name.toLowerCase();
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
                .then(() => {
                    this.playSong();
                })
                .catch((reason) => {
                    this.log('Did not join voice channel on connect: ' + reason);
                })
        });
            
        
        
        //Register Discord callbacks

        var self = this;
        
        this.denv.client.on("voiceStateUpdate", (oldState, state) => {
            if (state.guild.id != this.denv.server.id) return;
            
            let myid = this.denv.server.me.id;
            let llisteners = this.listeners.length;
            let dchanid = null;
            if (this.dchan) dchanid = this.dchan.id;
            
            if (oldState.channelID != dchanid && state.channelID == dchanid) {
                if (state.id == myid) {
                    if (llisteners) {
                        //I joined the channel
                        this.resumeSong() || this.playSong();
                    }
                } else {
                    if (this._skipper[state.id] && !state.deaf) {
                        //Skipper tried to undeafen themselves... Nah
                        state.setDeaf(true);
                    } else {

                        if (this.param('announcejoins')) {
                            this.announce('__Arrived__: ' + this.denv.idToDisplayName(state.id));
                        }

                        if (this._undeafen[state.id]) {
                            state.setDeaf(false);
                            delete this._undeafen[state.id];
                        }
                        if (!state.deaf) {
                            if (!this.playing) {
                                //First listener joined the channel
                                this.joinDchan()
                                    .catch((reason) => {
                                        this.log('Did not join voice channel on first listener: ' + reason);
                                    })
                            }
                            this.stayafterall(state.id);
                        }
                    }
                }
            }
            
            if (oldState.channelID == dchanid && state.channelID != dchanid) {
                if (state.id == myid) {
                    //I left the channel
                    if (!this._pause) this.stopSong();
                } else {

                    if (this.param('announcejoins')) {
                        this.announce('__Departed__: ' + this.denv.idToDisplayName(state.id));
                    }

                    this.autowithdraw(state.id);
                    this.clearautoend(state.id);
                    if (this._nopreference[state.id]) delete this._nopreference[state.id];
                    if (!llisteners) {
                        //Last listener left the channel
                        this.pauseSong();
                        this.dchan.leave();
                    }
                }
            }
            
            if (state.id == myid) {
                if (!oldState.mute && state.mute) {
                    //I was muted
                    this.pauseSong();
                }
                if (oldState.mute && !state.mute) {
                    //I was unmuted
                    this.resumeSong() || this.playSong();
                }
            } else {
                if (!oldState.deaf && state.deaf) {
                    if (!llisteners) {
                        //Last listener was deafened
                        this.pauseSong();
                        this.dchan.leave();
                    }
                } else if (oldState.deaf && !state.deaf) {
                    if (this._skipper[state.id] && state.channelID == dchanid) {
                        //Skipper tried to undeafen themselves... Nah
                        state.setDeaf(true);
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
        
        
        this.denv.client.on('presenceUpdate', (oldPresence, presence) => {
            if (presence.guild.id != this.denv.server.id) return;
            
            if (!oldPresence) return;
            
            if (oldPresence.status != "offline" && presence.status == "offline") {
                this.withdraw(presence.userID);
            }
        });
        
        this.denv.client.on("guildMemberRemove", (member) => {
            if (member.presence.status == "offline") return;
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

        opt.envs[this.param('env')].on('connected', () => {
            this.grabber.setAdditionalStats(this.metaprefix + '.latestnovelties', []);
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
                ep.reply('**[Playing]** ' + '`' + this._play.hash + ' ' + this._play.name + (this._play.author ? ' (' + this._play.author + ')' : '')
                    + ' <' + (this.strictlyPlaying ? this.secondsToHms(Math.round((this._seek + this.vc.dispatcher.streamTime) / 1000.0)) + ' / ' : '') + this.secondsToHms(this._play.length) + '>`');
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio skip', {
            description: 'Vote to skip the current song.',
            details: [
                "When a listener calls this command, if there are no listeners who haven't called it, the current song is skipped.",
                "Otherwise, the listener is deafened until the end of the song.",
                "If the listener leaves the channel or undeafens himself, his skip vote is revoked."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.playing || this._skipper[userid] || !this.islistener(userid)) return true;
            
            let listeners = this.listeners;
            
            let cskippers = Object.keys(this._skipper).length;
            let clisteners = listeners.length;
            
            for (let skipperid in this._skipper) {
                if (!listeners.find(item => item.id == skipperid)) {
                    clisteners += 1;
                }
            }
            
            ep.reply('OK (' + (cskippers+1) + '/' + clisteners + ').');
            
            this._skipper[userid] = true;
            
            if (cskippers >= clisteners - 1) {
                let skipdata = this.grabber.getSongMeta(this._play.hash, this.metaprefix + ".skipped");
                if (!skipdata) skipdata = {};
                
                let now = moment().unix();
                skipdata[now] = Object.keys(this._skipper);
                this.grabber.setSongMeta(this._play.hash, this.metaprefix + ".skipped", skipdata);

                let skips = this.grabber.getSongMeta(this._play.hash, this.metaprefix + ".skips");
                if (!skips) skips = 1; else skips += 1;
                this.grabber.setSongMeta(this._play.hash, this.metaprefix + ".skips", skips);

                let song = this._play;

                this.stopSong();

                if (this.param('announceskips')) {
                    this.announce('**[Skipped]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
                }

                //this.playSong(); No need; The ender will play the next song normally
                    
                return true;
            }
                        
            this.dchan.members.get(userid).setDeaf(true);
            
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'rajio end', {
            description: 'Automatically end listening session.',
            args: ['counter'],
            minArgs: 0,
            details: [
                "Sets how many songs, including the current one, should play before the listener is disconnected.",
                "Use 0 or 'cancel' to abort, and 'check' to see your current counter.",
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.islistener(userid)) {
                ep.reply('This command is only available to listeners.');
                return true;
            }
            
            if (!args.counter) args.counter = 1;
            
            if (args.counter == 'check') {
                ep.reply(this._userremaining[userid] !== undefined ? 'Remaining songs: ' + this._userremaining[userid] : 'You have not set an end counter.');
                return true;
            }
            
            if (args.counter == 'cancel') args.counter = 0;
            let counter = parseInt(args.counter);
            if (isNaN(counter)) {
                ep.reply('The argument must be a number, cancel or check.');
                return true;
            }
      
            if (counter == 0 && this._userremaining[userid] !== undefined) {
                delete this._userremaining[userid];
            } else if (counter > 0) {
                this._userremaining[userid] = counter;
            }
            
            ep.reply('OK.');
        
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
                let newchan = this.denv.server.channels.cache.get(args.channelid);
                if (!newchan || newchan.type != "voice") {
                    ep.reply('There is no voice channel with the specified ID.');
                    return true;
                }
                this._channel = args.channelid;
            } else {
                let me = this.denv.server.members.cache.get(userid);
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
            //this.playSong(); No need; The ender will play the next song normally
            
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
            
            let prioritycomponents = this.songPriority(this.grabber.hashSong(hash), this.listeners.map(listener => listener.id), false, false, true);
            
            for (let cname in prioritycomponents) {
                ep.reply('`' + cname + ' = ' + prioritycomponents[cname] + '`');
            }

            let queuepos = this._queue.findIndex(item => item.song.hash == hash);
            if (queuepos > -1) {
                ep.reply('`Queued in position ' + queuepos + ' .`');
            }

            if (this.isNovelty(hash)) {
                ep.reply('`This song can play as a novelty.`');
            }

            return true;
        });


        this.mod("Commands").registerRootDetails(this, 'rpref', {
            description: 'Commands for modifying your personal rajio preferences.',
            details: [
                'These preferences determine how songs are selected for you when you are listening.',
                'When there are multiple listeners, all listeners will have equal weight.',
                'See the rajio command for more information on this module.'
            ]
        });


        this.mod('Commands').registerCommand(this, 'rpref curator list', {
            description: "Lists whose preferences influence songs selected for you.",
            details: [
                "The likes of users whose names are prefixed with a `+` have a positive influence on your selections.",
                "On the other hand, users whose names are prefixed with a `-` have a negative (inverted) influence on your selections."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let curators = {};
            if (this._userdata[userid] && this._userdata[userid].curators) {
                curators = this._userdata[userid].curators;
            } else {
                curators = {};
                curators[userid] = true;
            }

            let curatorsresolved = [];
            for (let curatorid in curators) {
                curatorsresolved.push([env.idToDisplayName(curatorid), curators[curatorid]]);
            }

            if (!curatorsresolved.length) {
                ep.reply("Your curator list is currently empty (you don't affect song selection).");
                return true;
            }

            curatorsresolved.sort((a, b) => a[0].localeCompare(b[0]));
            ep.reply(curatorsresolved.map(curator => (curator[1] ? '+' : '-') + curator[0]).join(' ; '));

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref curator +', {
            description: "Adds someone's preferences to your curator list.",
            args: ["targetuser", true],
            details: [
                "Specify the display name or ID of yourself or another user."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this._userdata[userid] && this._userdata[userid].curators && Object.keys(this._userdata[userid].curators).length >= this.param('pref.maxcurators')) {
                ep.reply("You can't have more than " + this.param('pref.maxcurators') + " user" + (this.param('pref.maxcurators') > 1 ? "s" : "") + " in your curator list.");
                return true;
            }

            let targetuser = args.targetuser.join(" ");
            let targetid = env.displayNameToId(targetuser);
            if (!targetid) {
                if (env.idToDisplayName(targetuser) != targetuser) {
                    targetid = targetuser;
                } else {
                    ep.reply("User not found.");
                    return true;
                }
            }
            
            this.addCurator(userid, targetid, true);

            ep.reply("The user was added to your curator list.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref curator -', {
            description: "Adds someone's inverse preferences to your curator list.",
            args: ["targetuser", true],
            details: [
                "Specify the display name or ID of yourself or another user."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this._userdata[userid] && this._userdata[userid].curators && Object.keys(this._userdata[userid].curators).length >= this.param('pref.maxcurators')) {
                ep.reply("You can't have more than " + this.param('pref.maxcurators') + " user" + (this.param('pref.maxcurators') > 1 ? "s" : "") + " in your curator list.");
                return true;
            }

            let targetuser = args.targetuser.join(" ");
            let targetid = env.displayNameToId(targetuser);
            if (!targetid) {
                if (env.idToDisplayName(targetuser) != targetuser) {
                    targetid = targetuser;
                } else {
                    ep.reply("User not found.");
                    return true;
                }
            }
            
            this.addCurator(userid, targetid, false);

            ep.reply("The user was added to your curator list.");


            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref curator remove', {
            description: "Remove someone from your curator list.",
            args: ["targetuser", true],
            details: [
                "Specify the display name or ID of yourself or another user."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let targetuser = args.targetuser.join(" ");
            let targetid = env.displayNameToId(targetuser);
            if (!targetid) {
                targetid = targetuser;
            }

            if (!this.removeCurator(userid, targetid)) {
                ep.reply("Curator not found in your preferences.");
                return true;
            }

            ep.reply("The user was removed from your curator list.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref curator set', {
            description: "Replace your entire curator list.",
            args: ["newlist", true],
            minArgs: 0,
            details: [
                "Please provide a list in the same format that is returned by rajio pref curator list (users separated by `;` ). `+` will be assumed for unprefixed names.",
                "If you don't specify a list, it will be reset to default (you will be your own sole, positive curator).",
                "To clear the list entirely (your presence as a listener will have no effect on song selection) use `rajio pref curator set -` or remove yourself using rajio pref curator remove."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let curatorlist = args.newlist.join(" ").split(/;|\n/);

            if (!curatorlist.length || curatorlist.length == 1 && curatorlist[0] == "") {
                curatorlist.push(userid);
            } else if (curatorlist.length == 1 && curatorlist[0] == "-") {
                curatorlist = [];
            }

            let resolvedcurators = [];

            //Validate curators and convert to IDs
            for (let curcandidate of curatorlist) {
                let mode = true;
                curcandidate = curcandidate.trimLeft().trimRight();
                if (!curcandidate) continue;
                if (curcandidate.substr(0, 1) == '-') mode = false;
                if (curcandidate.substr(0, 1) == '-' || curcandidate.substr(0, 1) == '+') {
                    curcandidate = curcandidate.substr(1);
                }

                let targetid = env.displayNameToId(curcandidate);
                if (!targetid) {
                    if (env.idToDisplayName(curcandidate) != curcandidate) {
                        targetid = curcandidate;
                    } else {
                        ep.reply("User not found: " + curcandidate + ". Operation aborted.");
                        return true;
                    }
                }

                resolvedcurators.push([targetid, mode]);
            }

            if (this._userdata[userid] && this._userdata[userid].curators && resolvedcurators.length >= this.param('pref.maxcurators')) {
                ep.reply("You can't have more than " + this.param('pref.maxcurators') + " user" + (this.param('pref.maxcurators') > 1 ? "s" : "") + " in your curator list.");
                return true;
            }

            //Clear list of curators
            this.clearCurators(userid, resolvedcurators.length == 0);

            //Add curators
            for (let curator of resolvedcurators) {
                this.addCurator(userid, curator[0], curator[1]);
            }

            if (resolvedcurators.length == 0) {
                this._userdata.save();
                ep.reply("Curator list successfully cleared.");
            } else {
                ep.reply("Curator set to the specified user" + (resolvedcurators.length != 1 ? "s" : "") + ".");
            }

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref kw list', {
            description: "Lists keywords that influence songs selected for you.",
            details: [
                "Positive influence (liked) keywords: Songs will be penalized for not having that keyword in any field when being selected for you.",
                "Negative influence (disliked) keywords: Songs will be penalized for having that keyword in any field when being selected for you."
            ]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let keywords = {};
            if (this._userdata[userid] && this._userdata[userid].keywords) {
                keywords = this._userdata[userid].keywords;
            }

            let keywordsresolved = [];
            for (let keyword in keywords) {
                keywordsresolved.push([keyword, keywords[keyword]]);
            }

            if (!keywordsresolved.length) {
                ep.reply("Your keyword list is currently empty.");
                return true;
            }

            keywordsresolved.sort((a, b) => a[0].localeCompare(b[0]));
            ep.reply(keywordsresolved.map(keyword => (keyword[1] >= 0 ? '+' : '-') + keyword[0]).join(' ; '));

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref kw +', {
            description: "Adds a positive influence (liked) keyword to your preferences.",
            args: ["keyword", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this._userdata[userid] && this._userdata[userid].keywords && Object.keys(this._userdata[userid].keywords).length >= this.param('pref.maxkeywords')) {
                ep.reply("You can't have more than " + this.param('pref.maxkeywords') + " keyword" + (this.param('pref.maxkeywords') > 1 ? "s" : "") + " in your list.");
                return true;
            }

            this.addKeyword(userid, args.keyword.join(" "), 1.0);

            ep.reply("The keyword was added to your list.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref kw -', {
            description: "Adds a negative influence (disliked) keyword to your preferences.",
            args: ["keyword", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (this._userdata[userid] && this._userdata[userid].keywords && Object.keys(this._userdata[userid].keywords).length >= this.param('pref.maxkeywords')) {
                ep.reply("You can't have more than " + this.param('pref.maxkeywords') + " keyword" + (this.param('pref.maxkeywords') > 1 ? "s" : "") + " in your list.");
                return true;
            }

            this.addKeyword(userid, args.keyword.join(" "), -1.0);

            ep.reply("The keyword was added to your list.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref kw remove', {
            description: "Removes a keyword from your preferences.",
            args: ["keyword", true]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.removeKeyword(userid, args.keyword.join(" "))) {
                ep.reply("Keyword not found in your preferences.");
                return true;
            }

            ep.reply("The keyword was removed from you list.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref kw clear', {
            description: "Removes every keyword from your preferences."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            this.clearKeywords(userid, true);

            ep.reply("Your keyword list was cleared.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref profile list', {
            description: "Lists your saved profiles."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let profiles = {};
            if (this._userdata[userid] && this._userdata[userid].saved) {
                profiles = this._userdata[userid].saved;
            }

            let profileslist = Object.keys(profiles);

            if (!profileslist.length) {
                ep.reply("You don't have any saved profiles.");
                return true;
            }

            profileslist.sort((a, b) => a[0].localeCompare(b[0]));
            ep.reply(profileslist.join(', '));

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref profile save', {
            description: "Creates a snapshot of your current preferences which can be restored later.",
            args: ["name"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            let name = args.name.toLowerCase().trimLeft().trimRight();

            if (this._userdata[userid] && this._userdata[userid].saved && this._userdata[userid].saved[name]) {
                ep.reply("There already exists a profile with this name. If you want to replace it, erase the old profile first.");
                return true;
            }

            this.preferenceSave(userid, name);
            ep.reply("Profile created.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref profile load', {
            description: "Restores a previously created snapshot of your preferences.",
            args: ["name"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.preferenceLoad(userid, args.name)) {
                ep.reply("No such profile.");
                return true;
            }

            ep.reply("Profile loaded.");

            return true;
        });

        this.mod('Commands').registerCommand(this, 'rpref profile erase', {
            description: "Deletes a previously created snapshot of your preferences.",
            args: ["name"]
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.preferenceDeleteSave(userid, args.name)) {
                ep.reply("No such profile.");
                return true;
            }

            ep.reply("Profile removed.");

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
        if (!this.vc || this.playing || this.denv.server.me.voice.mute || !this.listeners.length || this._disabled) {
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
        if (!song.normalized) {
            let ref = this.param('referenceloudness');
            if (!isNaN(ref) && ref < 0) {
                if (song.sourceLoudness && song.sourceLoudness > ref) {  //Both negative numbers
                    att = Math.pow(10, (ref - song.sourceLoudness) / 20);
                }
            }
        }
        let volume = this._volume * att;
        
        let options = {
            volume: (volume != 1 ? volume : false),
            seek: (seek ? Math.round(seek / 1000.0) : 0),
            highWaterMark: 64,
            fec: this.param('fec')
        };
        
        this.grabber.setAdditionalStats(this.metaprefix + '.playing', song.hash);
        this._play = song;
        this._seek = seek || 0;
        this._pending = setTimeout(() => {
        
            this.abortskip();
        
            let ender = () => {
            
                let llisteners = this.listeners.length;
                let decreases = this.decreaseremaining();
                Promise.all(decreases).then(() => {
                    if (decreases.length >= llisteners) return; 
            
                    if (this._play) {
                        this.remember(this._play);
                    }
                    if (!this._pause) {
                        this.playSong();
                    }
                                
                });
                
            };
            
            if (song.format == 'pcm') {
                options.type = 'converted';
                this.vc.play(fs.createReadStream(this.grabber.songPathByHash(song.hash)), options).once("close", ender);
            } else {
                this.vc.play(this.grabber.songPathByHash(song.hash), options).once("close", ender);
            }
            
            this._pending = null;
        }, this.param('leadin') > 0 ? this.param('leadin') * 1000 : 1);
        
        return true;
    }
    
    stopSong() {
        this.log('Stopping song' + (this._play ? ': ' + this._play.hash : '.'));
        this.grabber.setAdditionalStats(this.metaprefix + '.playing', null);
        
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
        
        if (this.strictlyPlaying) {
            this._play = null;
            this._seek = 0;
            this._pause = true;  //Hack to stop the end event from playing next song
            this.vc.dispatcher.destroy();
        }
        
        this._pause = null;
        
        this.abortskip();
    }
    
    pauseSong() {
        if (!this.strictlyPlaying) {
            return this.stopSong();
        }
        
        let pausetime = this._seek + this.vc.dispatcher.streamTime;
        
        this.log('Pausing song: ' + this._play.hash + ' at ' + pausetime);
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity("*Paused*", {type: 'PLAYING'}).catch(() => {});
        }
        
        this._pause = [this._play, pausetime];
        this._play = null;
        this._seek = 0;
        this.vc.dispatcher.destroy();
        
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
        if (this._queue.find(item => item.song.hash == song.hash)) return false;
        
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

        this.grabber.setAdditionalStats(this.metaprefix + '.queue', this._queue.map((item) => ({hash: item.song.hash, userid: item.userid})));
        
        return true;
    }
    
    dequeue(getrequester) {
        let listeners = this.listeners.map((listener) => listener.id);
    
        let usequeue = (this._queue.length ? random.fraction() < this.param('pri.queue.chance') : false);
        let novelties = this.isThereANovelty(listeners);
        let usenovelty = (novelties ? random.fraction() < this.param('pri.novelty.chance') : false);

        let priorities = {};
        for (let hash of this.grabber.everySong()) {
            let priority = this.songPriority(this.grabber.hashSong(hash), listeners, usequeue, usenovelty);
            priorities[hash] = priority;
        }

        this.grabber.setAdditionalStats(this.metaprefix + '.latestpriorities', priorities);
        this.grabber.setAdditionalStats(this.metaprefix + '.latestnovelties', novelties || []);
        
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
        
        let index = this._queue.findIndex(item => item.song.hash == hash);
        let userid = null;
        if (index > -1) {
            userid = this._queue[index].userid;
            this._lastreq[hash] = moment().unix();
            this._queue.splice(index, 1);
            this.grabber.setAdditionalStats(this.metaprefix + '.queue', this._queue);
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
            this.grabber.setAdditionalStats(this.metaprefix + '.queue', this._queue);
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
    
    clearautoend(userid) {
        if (this._userremaining[userid]) {
            delete this._userremaining[userid];
        }
    }
    
    
    //Abort request to skip current song
    
    abortskip() {
        if (this.dchan) {
            let members = this.dchan.members;
            for (let userid in this._skipper) {
                if (members.get(userid) && members.get(userid).voice.deaf) {
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
    
    //Decrease counters for automatically ending listening sessions
    
    decreaseremaining(ignoredeafs) {
        let removals = [];
        if (this.dchan) {
            let members = this.dchan.members;
            for (let userid in this._userremaining) {
                if (members.get(userid) && (ignoredeafs || !members.get(userid).voice.deaf)) {
                    
                    //Request removal
                    this._userremaining[userid] -= 1;
                    if (this._userremaining[userid] < 1) {
                        delete this._userremaining[userid];
                        let promiseremoval = members.get(userid).voice.setChannel(null);
                        removals.push(promiseremoval);
                    }
                    
                }
            }
        }
        return removals;
    }
    
    //Remember played song
    
    remember(song) {
        this._history.unshift(song);
        if (this._history.length > this.param('historysize')) {
            this._history = this._history.slice(0, this.param('historysize'));
        }
        
        let plays = (this.grabber.getSongMeta(song.hash, this.metaprefix + ".plays") || 0) + 1;
        let now = moment().unix();

        this.grabber.setSongMeta(song.hash, this.metaprefix + ".lastplayed", now);
        this.grabber.setSongMeta(song.hash, this.metaprefix + ".plays", plays);

        let skipdata = this.grabber.getSongMeta(song.hash, this.metaprefix + ".skipped");
        if (skipdata) {
            for (let ts in skipdata) {
                if (now - ts > this.param('pri.listen.skiprange')) {
                    delete skipdata[ts];
                }
            }
            if (Object.keys(skipdata).length < 1) {
                skipdata = null;
            }
        }
        this.grabber.setSongMeta(song.hash, this.metaprefix + ".skipped", skipdata);

        this._playscache[song.hash] = plays;

        for (let listenerid of this.listeners.map((listener) => listener.id)) {
            if (!this._userlistened[listenerid]) {
                this._userlistened[listenerid] = 1;
            } else {
                this._userlistened[listenerid] += 1;
            }
        }
    }
    
    
    //Auxiliary
    
    islistener(userid) {
        if (!this.dchan) return false;
        let member = this.dchan.members.get(userid);
        return member && !member.voice.deaf;
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
        let userhistory = this._history.slice(0, this._userlistened[listener] || 0);

        let curators = {};
        if (!this._userdata[listener] || !this._userdata[listener].curators) curators[listener] = true;
        else curators = this._userdata[listener].curators;

        let slide = 0;
        for (let i = 0; i < userhistory.length; i++) {
            let song = userhistory[i];

            let comp = 0;
            if (Object.keys(curators).length) {
                for (let curator in curators) {
                    comp += (this.songrank.computeSongRank(song.hash, [curator]) || 0) * (curators[curator] ? 1 : -1);
                }
                comp /= Object.keys(curators).length;
            }

            if (comp <= 0) comp -= 0.5;
            comp *= -1 * Math.pow((userhistory.length - i) * this.param('pri.listen.historysc'), this.param('pri.listen.history'));
            slide += comp;
        }
        return slide;
    }

    playsRank(hash) {
        let songs = this.grabber.everySong();
        if (Object.keys(this._playscache).length != songs.length) {
            for (let songhash of songs) {
                if (!this._playscache[songhash]) {
                    this._playscache[songhash] = (this.grabber.getSongMeta(songhash, this.metaprefix + ".plays") || 0);
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

    calculateSkipMitigation(hash, listener, skipdata, now) {
        if (!skipdata) skipdata = this.grabber.getSongMeta(hash, this.metaprefix + ".skipped") || {};
        if (!now) now = moment().unix();
        
        let mostrecent = 0;
        for (let ts in skipdata) {
            if (ts > mostrecent && now - ts < this.param('pri.listen.skiprange') && skipdata[ts].findIndex(skipper => skipper == listener) > -1) {
                mostrecent = ts;
            }
        }

        if (!mostrecent) return 1;

        return Math.pow((now - mostrecent) / this.param('pri.listen.skiprange'), this.param('pri.listen.skipbias')) * (1 - this.param('pri.listen.skipfact')) + this.param('pri.listen.skipfact');
    }

    isNovelty(hash, songcount) {
        if (!songcount) songcount = this.grabber.everySong().length;
        let seen = this.grabber.getSongMeta(hash, "seen");
        if (!seen || moment().unix() - seen[0] > this.param('pri.novelty.duration')) return false;
        if ((this.grabber.getSongMeta(hash, this.metaprefix + ".plays") || 0) > this.param("pri.novelty.breaker")) return false;
        return true;
    }

    isThereANovelty(listeners) {
        let everysong = this.grabber.everySong();
        let songrank = this.songrank;
        let novelties = [];
        for (let hash of everysong) {
            if (this.isNovelty(hash, everysong.length)) {

                let voted = 0;
                if (songrank && listeners) {
                    for (let listenerid of listeners) {
                        if (songrank.getSongLikeability(hash, listenerid)) {
                            voted += 1;
                        }
                    }
                }
                
                if (!listeners || voted < listeners.length) {
                    novelties.push(hash);
                }
            }
        }
        if (novelties.length) return novelties;
        return false;
    }

    findKeywordsInSong(song, keywords) {
        for (let keyword of keywords) {
            if (song.name && song.name.toLowerCase().indexOf(keyword) > -1
                    || song.author && song.author.toLowerCase().indexOf(keyword) > -1
                    || song.album && song.album.toLowerCase().indexOf(keyword) > -1
                    || song.keywords.findIndex(kw => kw.toLowerCase().indexOf(keyword) > -1) > -1) {
                return true;
            }
        }
        return false;
    }

    
    songPriority(song, listeners, usequeue, usenovelty, trace) {
        let priority = this.param('pri.base');
        let components = {base: priority};
        let songcount = this.grabber.everySong().length;
        let now = moment().unix();
        
        let prelisteners = (listeners || []);
        listeners = [];
        for (let userid of prelisteners) {
            if (this._nopreference[userid]) continue;
            listeners.push(userid);
        }

        let skipdata = this.grabber.getSongMeta(song.hash, this.metaprefix + ".skipped") || {};
        
        
        //Rank-based components
        
        let songrank = this.songrank;
        
        if (songrank) {
            //Global rank
            let calcrank = songrank.computeSongRank(song.hash, null, true);
            let crank = (calcrank.rank || 0);
            if (calcrank.users.length) crank /= calcrank.users.length;
            crank *= this.param('pri.rank');
            priority += crank;
            if (trace) components.rank = crank;
            
            //Listener components
            if (listeners.length) {
                let clisten = 0;

                for (let listener of listeners) {
                    let curated = 0;

                    //Base rank for each listener (from curators)
                    let curators = {};
                    if (!this._userdata[listener] || !this._userdata[listener].curators) curators[listener] = true;
                    else curators = this._userdata[listener].curators;
                    if (!Object.keys(curators).length) continue;

                    for (let curator in curators) {
                        curated += (songrank.computeSongRank(song.hash, [curator]) || 0) * (curators[curator] ? 1 : -1);
                    }
                    curated /= Object.keys(curators).length;
                    curated *= this.param('pri.listen');
                    curated /= listeners.length;

                    if (trace) components["listener." + listener] = curated;

                    //Keyword attenuation
                    let keywordspos = [];
                    let keywordsneg = [];
                    if (this._userdata[listener] && this._userdata[listener].keywords) {
                        let keywords = this._userdata[listener].keywords;
                        for (let keyword in keywords) {
                            if (keywords[keyword] > 0) keywordspos.push(keyword);
                            else keywordsneg.push(keyword);
                        }
                    }

                    let posfound = this.findKeywordsInSong(song, keywordspos);
                    let negfound = this.findKeywordsInSong(song, keywordsneg);

                    if (curated > 0 && keywordspos.length && !posfound || curated < 0 && posfound) {
                        curated *= this.param('pri.listen.nopos');
                    }
                    if (curated > 0 && negfound || curated < 0 && keywordsneg.length && !negfound) {
                        curated *= this.param('pri.listen.yesneg');
                    }

                    if (trace) components["withkeywords." + listener] = curated;

                    //Skip attenuation
                    if (curated > 0) {
                        let skipfactor = this.calculateSkipMitigation(song.hash, listener, skipdata, now);
                        curated *= skipfactor;
                        if (trace && skipfactor < 1) components["withskips." + listener] = curated;
                    }

                    clisten += curated;
                }

                //Slide
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
        
        let plays = song[this.metaprefix + ".plays"] || 0;
        let clowplays = (1 - Math.min(this.param('pri.lowplays.max'), plays) / this.param('pri.lowplays.max')) * this.param('pri.lowplays');
        priority += clowplays;
        if (trace) components.lowplays = clowplays;


        //Comparative plays

        if (priority < 0) priority = 0;
        if (trace) components.baseabsolute = priority;
        let playsrank = this.playsRank(song.hash);
        let playsfactor = Math.log(playsrank + 1) / Math.log(1 + songcount * this.param('pri.mitigatedslice'));
        if (trace) components.playsfactor = playsfactor;
        priority = Math.pow(priority, playsfactor);
        if (trace) components.withplays = priority;


        //Recently played song mitigation
        
        let recentgradient = Math.min(now - (song[this.metaprefix + ".lastplayed"] || 0), this.param('pri.recent')) / this.param('pri.recent');
        priority *= recentgradient;
        if (trace) components.withrecent = priority;


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
            let queuepos = this._queue.findIndex(item => item.song.hash == song.hash);
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


    //Preferences

    addCurator(userid, targetid, mode) {
        if (!this._userdata[userid]) this._userdata[userid] = {};
        if (!this._userdata[userid].curators) {
            this._userdata[userid].curators = {};
            this._userdata[userid].curators[userid] = true;
        }

        this._userdata[userid].curators[targetid] = !!mode;

        this._userdata.save();
        return true;
    }

    removeCurator(userid, targetid) {
        if (!this._userdata[userid] || !this._userdata[userid].curators || this._userdata[userid].curators[targetid] === undefined) {
            return false;
        }

        delete this._userdata[userid].curators[targetid];

        this._userdata.save();
        return true;
    }

    clearCurators(userid, save) {
        if (!this._userdata[userid] || !this._userdata[userid].curators) {
            return false;
        }

        this._userdata[userid].curators = {};
        if (save) this._userdata.save();
        return true;
    }

    addKeyword(userid, keyword, rating) {
        keyword = keyword.toLowerCase().trimLeft().trimRight();

        if (!this._userdata[userid]) this._userdata[userid] = {};
        if (!this._userdata[userid].keywords) this._userdata[userid].keywords = {};
        
        this._userdata[userid].keywords[keyword] = parseFloat(rating);

        this._userdata.save();
        return true;
    }

    removeKeyword(userid, keyword) {
        keyword = keyword.toLowerCase().trimLeft().trimRight();

        if (!this._userdata[userid] || !this._userdata[userid].keywords || this._userdata[userid].keywords[keyword] === undefined) {
            return false;
        }

        delete this._userdata[userid].keywords[keyword];

        this._userdata.save();
        return true;
    }

    clearKeywords(userid, save) {
        if (!this._userdata[userid] || !this._userdata[userid].keywords) {
            return false;
        }

        this._userdata[userid].keywords = {};
        if (save) this._userdata.save();
        return true;
    }

    preferenceSave(userid, savename) {
        savename = savename.toLowerCase().trimLeft().trimRight();

        if (!this._userdata[userid]) this._userdata[userid] = {};
        if (!this._userdata[userid].saved) this._userdata[userid].saved = {};
        
        let defcurators = {};
        defcurators[userid] = true;

        this._userdata[userid].saved[savename] = {
            curators: Object.assign({}, this._userdata[userid].curators || defcurators),
            keywords: Object.assign({}, this._userdata[userid].keywords || {})
        };

        this._userdata.save();
        return true;
    }

    preferenceLoad(userid, savename) {
        savename = savename.toLowerCase().trimLeft().trimRight();

        if (!this._userdata[userid] || !this._userdata[userid].saved || !this._userdata[userid].saved[savename])  {
            return false;
        }

        this._userdata[userid].curators = Object.assign({}, this._userdata[userid].saved[savename].curators);
        this._userdata[userid].keywords = Object.assign({}, this._userdata[userid].saved[savename].keywords);

        this._userdata.save();
        return true;
    }

    preferenceDeleteSave(userid, savename) {
        savename = savename.toLowerCase().trimLeft().trimRight();

        if (!this._userdata[userid] || !this._userdata[userid].saved || !this._userdata[userid].saved[savename])  {
            return false;
        }

        delete this._userdata[userid].saved[savename];

        this._userdata.save();
        return true;
    }
    
    
}


module.exports = ModRajio;
