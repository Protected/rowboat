import moment from 'moment';
import { ExactNumber as N, log, log10, pow as exactPow } from 'exactnumber';
import random from 'meteor-random';
import { randomInt } from 'crypto';
import emoji from 'emoji-toolkit';
import { ActivityType, ChannelType } from 'discord.js';
import prism from 'prism-media';
import { createAudioPlayer, AudioPlayerStatus, AudioResource,
    getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice';

import Behavior from '../src/Behavior.js';

const PRIORITY_MAX_PRECISION_DECIMALS = 10000;
const DECIMALS = log10(PRIORITY_MAX_PRECISION_DECIMALS, 0).toNumber();
const FFMPEG_PCM_ARGUMENTS = ['-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', '48000', '-ac', '2'];


function pow(base, exp, dec) {
    if (N(base).eq(0)) return N(0);
    return exactPow(base, exp, dec);
}


function createAudioResourceAndSeek(input, options) {

    let ffmpegArguments = [...FFMPEG_PCM_ARGUMENTS];
    
    if (options.seekTo) {
        ffmpegArguments = ['-ss', options.seekTo, ...ffmpegArguments];
    }

    const edgeArbitraryToRaw = {
        type: 'ffmpeg pcm with seek',
        to: null,  //Not actually using TransformerGraph
        cost: 2,
        transformer: (input) =>
            new prism.FFmpeg({
                args: ['-i', input, ...ffmpegArguments],
            }),
    };

    const volumeTransformer = {  //Unmodified
        type: 'volume transformer',
        to: null,  //Not actually using TransformerGraph
        cost: 0.5,
        transformer: () => new prism.VolumeTransformer({ type: 's16le' }),
    }

    const edgeRawToOpus = {  //Unmodified
        type: 'opus encoder',
        to: null,  //Not actually using TransformerGraph
        cost: 1.5,
        transformer: () => new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 }),
    }

    const transformerPipeline = [edgeArbitraryToRaw];
    if (options.inlineVolume) transformerPipeline.push(volumeTransformer);
    transformerPipeline.push(edgeRawToOpus);

    const streams = transformerPipeline.map((edge) => edge.transformer(input));

    return new AudioResource(
        transformerPipeline,
        streams,
        options.metadata ?? null,
        options.silencePaddingFrames ?? 5,
    );
}


export default class Radio extends Behavior {
    
    get description() { return "Grabber add-on for playing songs on discord voice channels"; }

    get params() { return [
        {n: 'datafile', d: "Customize the name of the default data file"},
        
        {n: 'channel', d: "ID of a Discord audio channel to join by default"},
        {n: 'leadin', d: "Length of silence, in seconds, before each new song is played"},
        {n: 'pause', d: "Maximum amount of time in seconds to keep the current song paused when the module loses all listeners"},
        {n: 'autowithdraw', d: "How long in seconds before a user withdraws from the queue if they are online but not a listener"},
        {n: 'queuesize', d: "Maximum amount of songs in the request queue"},
        {n: 'historysize', d: "Maximum amount of recently played songs to remember"},
        {n: 'referenceloudness', d: "Negative decibels; Play songs with higher loudness at a lower volume to compensate"},
        {n: 'volume', d: "Global volume multipler; Defaults to 1.0 and can be changed via command"},
        
        {n: 'announcechannel', d: "ID of a Discord text channel to announce radio status information to"},
        {n: 'announcedelay', d: "Minimum seconds between song announces"},
        {n: 'announcesongs', d: "Announce when a song starts playing (true/false)"},
        {n: 'announcejoins', d: "Announce when people start/stop listening (true/false)"},
        {n: 'announceskips', d: "Announce skipped songs (true/false)"},

        {n: 'usestatus', d: "Announce current song in bot's game (true/false)"},
        
        {n: 'pri.base', d: "Base priority"},
        {n: 'pri.rank', d: "Global song rank priority component"},
        {n: 'pri.listen', d: "Unbiased listener rank priority component"},
        {n: 'pri.listen.nopos', d: "Attenuate listener priority for songs with no positive preference keywords associated"},
        {n: 'pri.listen.yesneg', d: "Attenuate listener priority for songs with negative preference keywords associated"},
        {n: 'pri.listen.skiprange', d: "(s) For how long after a song last skipped its positive listener rank is mitigated"},
        {n: 'pri.listen.skipbias', d: "Exponent/bias for skip mitigation (1 will make it linear, otherwise weight towards early or late in period)"},
        {n: 'pri.listen.skipfact', d: "Minimum (most impactful) coefficient applied by skipping (if song was just skipped)"},
        {n: 'pri.listen.slide', d: "Weight of listener bias on rank, if applicable"},
        {n: 'pri.listen.history', d: "Weight of history position bias on slide, if applicable"},
        {n: 'pri.listen.historysc', d: "Multiplier for history position bias"},
        {n: 'pri.length', d: "Ideal length priority component"},
        {n: 'pri.length.minlen', d: "(s) Minimum ideal song length"},
        {n: 'pri.length.maxlen', d: "(s) Maximum ideal song length"},
        {n: 'pri.length.maxexcs', d: "(s) Song length after which priority bonus is 0)"},
        {n: 'pri.lowplays', d: "Low plays priority component"},
        {n: 'pri.lowplays.max', d: "Maximum amount of plays to receive this bonus"},
        {n: 'pri.mitigatedslice', d: "[0-1] Position of the plays-sorted library where priority multiplier is 1"},
        {n: 'pri.recent', d: "(s) For how long after a song last played its priority is mitigated (on a linear gradient)"},
        {n: 'pri.unanimous.meh', d: "[0-1] Multiplier for priority if not all listeners hate the song, but all of them hate or dislike the song (<= -1)"},
        {n: 'pri.unanimous.hate', d: "[0-1] Multiplier for priority if all listeners hate the song (-2)"},
        {n: 'pri.queue.chance', d: "[0-1] Odds that only a queued song will not have 0 priority, if there are queued songs"},
        {n: 'pri.novelty.chance', d: "[0-1] Odds that only a novelty will not have 0 priority, if there are novelties"},
        {n: 'pri.novelty.duration', d: "(s) For how long a new song is considered a novelty"},
        {n: 'pri.novelty.breaker', d: "Maximum amount of plays above which a novelty is not treated as one"},

        {n: 'pref.maxcurators', d: "Maximum amount of curators per player"},
        {n: 'pref.maxkeywords', d: "Maximum amount of keywords per player"}
    ]; }

    get defaults() { return { 
        datafile: null,
        
        channel: null,
        leadin: 5,
        pause: 900,
        autowithdraw: 120,
        queuesize: 10,
        historysize: 20,
        referenceloudness: -20,
        volume: 1.0,
        
        announcechannel: null,
        announcedelay: 0,
        announcesongs: true,
        announcejoins: true,
        announceskips: true,

        usestatus: true,

        /*
            LISTENER_CURATORS_RANK = Sum_[curator](-1? * CURATOR_RANK)/curators

            KWPREF_FACTOR: If "+" exist and none present, * pri.listen.nopos ,If "-" exist and present, * pri.listen.yesneg

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

        "pri.base": "10.0",
        "pri.rank": "10.0",
        "pri.listen": "50.0",
        "pri.listen.nopos": "0.75",
        "pri.listen.yesneg": "0.10",
        "pri.listen.skiprange": "259200",
        "pri.listen.skipbias": "2",
        "pri.listen.skipfact": "0.1",
        "pri.listen.slide": "0.5",
        "pri.listen.history": "0.3",
        "pri.listen.historysc": "3",
        "pri.length": "10.0",
        "pri.length.minlen": "180",
        "pri.length.maxlen": "600",
        "pri.length.maxexcs": "900",
        "pri.lowplays": "30.0",
        "pri.lowplays.max": "3",
        "pri.mitigatedslice": "0.1",
        "pri.recent": "86400",
        "pri.unanimous.meh": "0.65",
        "pri.unanimous.hate": "0.05",

        /*
            If there are queued songs:
            SONG_PRIORITY = rand() < pri.queue.chance
                ? (isqueued ? (maxqueue - QUEUE_POSITION) / maxqueue : 0)
                : SONG_PRIORITY
        */

        "pri.queue.chance": "1.0",

        /*
            If there are novelties (novelty is defined as: song shared less than pri.novelty.duration seconds ago and with less than pri.novelty.breaker plays)
            SONG_PRIORITY = rand() < pri.novelty.chance
                ? (isnovelty ? SONG_PRIORITY : 0)
                : SONG_PRIORITY
        */

        "pri.novelty.chance": "0.05",
        "pri.novelty.duration": "691200", //8 days
        "pri.novelty.breaker": "8",

        "pref.maxcurators": 3,
        "pref.maxkeywords": 8
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands',
        Grabber: 'Grabber'
    }; }

    get optionalBehaviors() { return {
        SongRanking: 'SongRanking'
    }; }

    get isMultiInstanceable() { return true; }

    constructor(name) {
        super('Radio', name);
        
        this._userdata = {};  // {userid: {curators: {userid: boolean, ...}, keywords: {keyword: rating, ...}, saved: {profilename: {...}}}}
        
        this._announced = null;  //Song announcement timestamp
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

        this._audioPlayer = null;  //AudioPlayer instance which manages audio streams being played
        this._audioPlayerStatus = AudioPlayerStatus.Idle;  //Tracks AudioPlayher status
        this._audioPlayerPlayTime = null;  //Timestamp when the player last went into Playing status.
        
        this._play = null;  //Song being played
        this._seek = 0;  //Starting time of the song being played, for time calculation purposes (s)
        this._pending = null;  //Timer that will start the next song
        this._pause = null;  //[song, seek] for resuming paused song
        this._expirepause = null;  //Timer that will expire (stop) a paused song
    }
    
    get grabber() {
        return this.be('Grabber');
    }
    
    get songrank() {
        return this.be('SongRanking') || null;
    }
    
    get denv() {
        return this.env("Discord");
    }
    
    get dchan() {
        return this.denv.server.channels.cache.get(this._channel);
    }

    get vc() {
        return getVoiceConnection(this.denv.server.id);
    }
    
    get listeners() {
        let me = this.denv.server.members.me;
        if (me.voice.mute) return [];
        let dchan = this.dchan;
        if (!dchan) return [];
        return [...dchan.members.filter((member) => member.id != me.id && !member.voice.deaf).values()];
    }
    
    get playing() {
        return !!this.vc && this._audioPlayerStatus === AudioPlayerStatus.Playing || this._pending;
    }
    
    get strictlyPlaying() {
        return !!this.vc && this._audioPlayerStatus === AudioPlayerStatus.Playing;
    }

    get playTime() {
        return this.playing ? moment().unix() - this._audioPlayerPlayTime : 0;
    }

    get metaprefix() {
        return 'radio.' + this.name.toLowerCase();
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;        
        
        this._userdata = this.loadData();
        if (this._userdata === false) return false;
        
        
        this._channel = this.param('channel');
        this._volume = parseFloat(this.param('volume'));
        
        
        //Prepare player
        
        this.denv.on("connected", () => {

            this._audioPlayer = createAudioPlayer();
            this._audioPlayer.on("stateChange", (oldState, newState) => {
                this._audioPlayerStatus = newState.status;
            })

            this.joinDchan()
                .then(() => this.playSong())
                .catch((reason) => {
                    this.log('Did not join voice channel on connect: ' + reason + " " + (reason.stack || ""));
                });

        });
            
        
        
        //Register Discord callbacks
        
        this.denv.client.on("voiceStateUpdate", async (oldState, state) => {
            if (state.guild.id != this.denv.server.id) return;
            
            let myid = this.denv.server.members.me.id;
            let llisteners = this.listeners.length;
            let dchanid = null;
            if (this.dchan) dchanid = this.dchan.id;
            
            if (oldState.channelId != dchanid && state.channelId == dchanid) {
                if (state.id == myid) {
                    if (llisteners) {
                        //I joined the channel
                        await this.resumeSong() || await this.playSong();
                    }
                } else {
                    if (this._skipper[state.id] && !state.deaf) {
                        //Skipper tried to undeafen themselves... Nah
                        state.setDeaf(true);
                    } else {

                        if (this.param('announcejoins')) {
                            this.announce('__Arrived__: ' + await this.denv.idToDisplayName(state.id));
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
            
            if (oldState.channelId == dchanid && state.channelId != dchanid) {
                if (state.id == myid) {
                    //I left the channel
                    if (!this._pause) await this.stopSong();
                } else {

                    if (this.param('announcejoins')) {
                        this.announce('__Departed__: ' + await this.denv.idToDisplayName(state.id));
                    }

                    this.autowithdraw(state.id);
                    this.clearautoend(state.id);
                    if (this._nopreference[state.id]) delete this._nopreference[state.id];
                    if (!llisteners) {
                        //Last listener left the channel
                        this.pauseSong();
                        this.vc.disconnect();
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
                    await this.resumeSong() || await this.playSong();
                }
            } else {
                if (!oldState.deaf && state.deaf) {
                    if (!llisteners) {
                        //Last listener was deafened
                        this.pauseSong();
                        this.vc.disconnect();
                    }
                } else if (oldState.deaf && !state.deaf) {
                    if (this._skipper[state.id] && state.channelId == dchanid) {
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
                this.withdraw(presence.userId);
            }
        });
        
        this.denv.client.on("guildMemberRemove", (member) => {
            if (!member.presence || member.presence.status == "offline") return;
            if (member.guild.id != this.denv.server.id) return;
            this.withdraw(member.user.id);
        });
        
        
        //Register module integrations
        
        this.grabber.registerParserFilter("$NUMBER", /^[$]([0-9]+)?$/, (str, match, userid) => {
            if ((!match[1] || match[1] == "0") && this._play) return this._play.hash;
            if (match[1] && this._history[match[1] - 1]) {
                return this._history[match[1] - 1].hash;
            }
            return null;
        }, "References the latest played song or a recently played song (NUMBER songs ago).");

        this.denv.on('connected', () => {
            this.grabber.setAdditionalStats(this.metaprefix + '.latestnovelties', []);
        }, this);
        

        //Register commands

        const permAdmin = this.be("Users").defaultPermAdmin;
        const permMod = this.be("Users").defaultPermMod;

        this.be("Commands").registerRootDetails(this, 'radio', {
            description: 'Commands for controlling the radio queue and playback.'
        });

        this.be('Commands').registerCommand(this, 'radio now', {
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
                    + ' <' + (this.strictlyPlaying ? this.secondsToHms(this._seek + this.playTime) + ' / ' : '') + this.secondsToHms(this._play.length) + '>`');
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'radio skip', {
            description: 'Vote to skip the current song.',
            details: [
                "When a listener calls this command, if there are no listeners who haven't called it, the current song is skipped.",
                "Otherwise, the listener is deafened until the end of the song.",
                "If the listener leaves the channel or undeafens himself, his skip vote is revoked."
            ]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
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
                let skipdata = await this.grabber.getSongMeta(this._play.hash, this.metaprefix + ".skipped");
                if (!skipdata) skipdata = {};
                
                let now = moment().unix();
                skipdata[now] = Object.keys(this._skipper);
                await this.grabber.setSongMeta(this._play.hash, this.metaprefix + ".skipped", skipdata);

                let skips = await this.grabber.getSongMeta(this._play.hash, this.metaprefix + ".skips");
                if (!skips) skips = 1; else skips += 1;
                await this.grabber.setSongMeta(this._play.hash, this.metaprefix + ".skips", skips);

                let song = this._play;

                await this.stopSong();

                if (this.param('announceskips')) {
                    this.announce('**[Skipped]** ' + '`' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
                }

                return true;
            }
                        
            this.dchan.members.get(userid).voice.setDeaf(true);
            
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'radio end', {
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
            
            ep.ok();
        
            return true;
        });
        
        

        this.be('Commands').registerCommand(this, 'radio off', {
            description: 'Disable the radio. This will stop it from playing music.',
            permissions: [permAdmin, permMod]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) {
                ep.reply('The radio is already disabled.');
                return true;
            }
            
            this._disabled = true;
            await this.stopSong();
            
            if (this.vc) {
                this.vc.disconnect();
            }
            
            ep.reply('The radio has now been disabled.');

            return true;
        });

        
        this.be('Commands').registerCommand(this, 'radio on', {
            description: 'Enable or re-enable the radio in an existing voice channel.',
            args: ['channelid'],
            minArgs: 0,
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this._disabled) {
                ep.reply('The radio is already enabled!');
                return true;
            }

            if (args.channelid) {
                let newchan = this.denv.server.channels.cache.get(args.channelid);
                if (!newchan || newchan.type != ChannelType.GuildVoice) {
                    ep.reply('There is no voice channel with the specified ID.');
                    return true;
                }
                this._channel = args.channelid;
            } else {
                let me = this.denv.server.members.cache.get(userid);
                if (me && me.voice.channelId) {
                    this._channel = me.voice.channelId;
                }
            }
            
            if (!this.dchan || this.dchan.type != ChannelType.GuildVoice) {
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
        
        
        this.be('Commands').registerCommand(this, 'radio volume', {
            description: 'Adjust the master volume attenuation.',
            args: ['volume'],
            details: [
                "Use a value between 0.0 (no sound) and 1.0 (maximum)."
            ],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            let volume = parseFloat(args.volume);
            if (isNaN(volume) || volume < 0 || volume > 1) {
                ep.reply('Please specify a number between 0.0 and 1.0 .');
                return true;
            }
            
            this._volume = volume;
            ep.ok();
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'radio another', {
            description: 'End playback of the current song and play the next one in the queue.',
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (this._disabled) return true;
        
            this.stopSong();
            //By just ending the current song, the next song is played normally
            
            return true;
        });
        
        
        let requestcommand = (demand) => async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            if (args.hashoroffset.length > 1 && !arg.match(/^\(.*\)$/)) {
                arg = '(' + arg + ')';
            }
        
            let hash = await this.grabber.bestSongForHashArg(arg, userid);
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
            
            let song = await this.grabber.hashSong(hash);
            if (!this.enqueue(song, userid, demand)) {
                ep.reply('The queue is full or the song is already in the queue.');
                return true;
            }
            
            if (!this.islistener(userid)) {
                this.autowithdraw(userid);
            }
            
            ep.ok();
        
            return true;
        }
        
        this.be('Commands').registerCommand(this, 'radio request', {
            description: 'Requests playback of a song in the library, which will be added to the queue if possible.',
            args: ['hashoroffset', true]
        }, requestcommand(false));
        
        this.be('Commands').registerCommand(this, 'radio demand', {
            description: 'Puts a song from the library at the top of the queue.',
            args: ['hashoroffset', true],
            permissions: [permAdmin, permMod]
        }, requestcommand(true));
        
        
        this.be('Commands').registerCommand(this, 'radio withdraw', {
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
        
        
        this.be('Commands').registerCommand(this, 'radio queue', {
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
                ep.reply('`[' + pos + '] #' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'radio history', {
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
                ep.reply('`[$' + pos + '] #' + song.hash + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + '`');
            }
        
            return true;
        });
        
        
        this.be('Commands').registerCommand(this, 'radio neutral', {
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
        
        
        this.be('Commands').registerCommand(this, 'radio apriority', {
            description: 'Analyze a song\'s current priority value.',
            args: ['hashoroffset', true]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            let arg = args.hashoroffset.join(" ");
            
            let hash = await this.grabber.bestSongForHashArg(arg);
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
            
            let prioritycomponents = await this.songPriority(await this.grabber.hashSong(hash), this.listeners.map(listener => listener.id), false, false, true);
            
            for (let cname in prioritycomponents) {
                ep.reply('`' + cname + ' = ' + prioritycomponents[cname].toString() + '`');
            }

            let queuepos = this._queue.findIndex(item => item.song.hash == hash);
            if (queuepos > -1) {
                ep.reply('`Queued in position ' + queuepos + ' .`');
            }

            if (await this.isNovelty(hash)) {
                ep.reply('`This song can play as a novelty.`');
            }

            return true;
        });


        this.be("Commands").registerRootDetails(this, 'rpref', {
            description: 'Commands for modifying your personal radio preferences.',
            details: [
                'These preferences determine how songs are selected for you when you are listening.',
                'When there are multiple listeners, all listeners will have equal weight.',
                'See the radio command for more information on this module.'
            ]
        });


        this.be('Commands').registerCommand(this, 'rpref curator list', {
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

        this.be('Commands').registerCommand(this, 'rpref curator +', {
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

        this.be('Commands').registerCommand(this, 'rpref curator -', {
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

        this.be('Commands').registerCommand(this, 'rpref curator remove', {
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

        this.be('Commands').registerCommand(this, 'rpref curator set', {
            description: "Replace your entire curator list.",
            args: ["newlist", true],
            minArgs: 0,
            details: [
                "Please provide a list in the same format that is returned by radio pref curator list (users separated by `;` ). `+` will be assumed for unprefixed names.",
                "If you don't specify a list, it will be reset to default (you will be your own sole, positive curator).",
                "To clear the list entirely (your presence as a listener will have no effect on song selection) use `radio pref curator set -` or remove yourself using radio pref curator remove."
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

        this.be('Commands').registerCommand(this, 'rpref kw list', {
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

        this.be('Commands').registerCommand(this, 'rpref kw +', {
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

        this.be('Commands').registerCommand(this, 'rpref kw -', {
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

        this.be('Commands').registerCommand(this, 'rpref kw remove', {
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

        this.be('Commands').registerCommand(this, 'rpref kw clear', {
            description: "Removes every keyword from your preferences."
        }, (env, type, userid, channelid, command, args, handle, ep) => {

            this.clearKeywords(userid, true);

            ep.reply("Your keyword list was cleared.");

            return true;
        });

        this.be('Commands').registerCommand(this, 'rpref profile list', {
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

        this.be('Commands').registerCommand(this, 'rpref profile save', {
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

        this.be('Commands').registerCommand(this, 'rpref profile load', {
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

        this.be('Commands').registerCommand(this, 'rpref profile erase', {
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
        if (this._disabled) return Promise.reject("Radio is disabled.");
        if (!this.listeners.length) return Promise.reject("No listeners.");
        if (!this.dchan || this.dchan.type != ChannelType.GuildVoice) return Promise.reject("Voice channel not found.");
        return new Promise((resolve, reject) => {
            let voiceConnection = joinVoiceChannel({
                adapterCreator: this.denv.server.voiceAdapterCreator,
                guildId: this.denv.server.id,
                channelId: this.dchan.id,
                selfMute: false,
                selfDeaf: false
            });
            let voiceConnectionDestroyed = false;
            voiceConnection.on(VoiceConnectionStatus.Ready, () => {
                voiceConnection.subscribe(this._audioPlayer);
                resolve(voiceConnection);
            });
            voiceConnection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
                try {
                    await Promise.race([
                        entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    // Seems to be reconnecting to a new channel - ignore disconnect
                } catch (error) {
                    // Seems to be a real disconnect which SHOULDN'T be recovered from
                    if (!voiceConnectionDestroyed) {
                        try {
                            voiceConnection.destroy();
                        } finally {
                            voiceConnectionDestroyed = true;
                        }
                    }
                    reject(newState.reason || "Unknown reason.");
                }
            })
            voiceConnection.on("error", (error) => {
                this.log("error", "Voice channel error: " + error);
            });
        });
    }

    
    //Internal playback control
    
    async playSong(song, seek) {
        if (!this.vc || this.playing || this.denv.server.members.me.voice.mute || !this.listeners.length || this._disabled) {
            return false;
        }
        
        let userid = null;
        if (!song) {
            song = await this.dequeue(true);
            if (!song) return false;
            userid = song[1];
            song = song[0];
        }
        
        if (!song || !song.hash) return false;
                
        this.log('Playing song: ' + song.hash);
        
        if (this.param('announcesongs') && (!this._announced || moment().unix() > this._announced + this.param('announcedelay'))) {
            let reqby = '';
            if (userid) {
                reqby = ' ** Requested by __' + await this.denv.idToDisplayName(userid) + '__';
            }

            //This block is for displaying likes in the announcement channel
            let likespart = '';
            let songrank = this.songrank;
            if (songrank) {
                let likes = await songrank.getAllSongLikes(song.hash);
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

            this.announce('**[' + (seek ? 'Resuming' : 'Now Playing') + ']** ' + '`#' + song.hash
                    + ' ' + song.name + (song.author ? ' (' + song.author + ')' : '') + ' <' + this.secondsToHms(song.length) + '>`' + likespart + reqby);
            this._announced = moment().unix();
        }
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity(song.name + (song.author ? " (" + song.author + ")" : ""), {type: ActivityType.Playing});
        }
        
        let att = 1.0;
        let ref = this.param('referenceloudness');
        if (!isNaN(ref) && ref < 0) {
            if (song.loudness && song.loudness > ref) {  //Both negative numbers
                att = Math.min(Math.pow(10, (ref - song.loudness + (song.tweak || 0)) / 20), 1.0);
            }
        }
        let volume = this._volume * att;

        let audioResource = createAudioResourceAndSeek(await this.grabber.songPathByHash(song.hash), {
            inlineVolume: volume != 1,
            metadata: { hash: song.hash },
            seekTo: seek || undefined
        });

        if (volume != 1) audioResource.volume.setVolume(volume);
        
        await this.grabber.setAdditionalStats(this.metaprefix + '.playing', song.hash);
        this._play = song;
        this._seek = seek || 0;
        this._pending = setTimeout(() => (async () => {
        
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
            
            this._audioPlayer.play(audioResource);
            this._audioPlayer.once(AudioPlayerStatus.Idle, ender);
            this._audioPlayerPlayTime = moment().unix();
            
            this._pending = null;
        })(), this.param('leadin') > 0 ? this.param('leadin') * 1000 : 1);
        
        return true;
    }
    
    async stopSong() {
        this.log('Stopping song' + (this._play ? ': ' + this._play.hash : '.'));
        await this.grabber.setAdditionalStats(this.metaprefix + '.playing', null);
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setPresence({ activities: [] });
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
            this._audioPlayer.stop();
        }
        
        this._pause = null;
        
        this.abortskip();
    }
    
    async pauseSong() {
        if (!this.strictlyPlaying) {
            return this.stopSong();
        }
        
        let pausetime = this._seek + this.playTime;
        
        this.log('Pausing song: ' + this._play.hash + ' at ' + pausetime);
        
        if (this.param('usestatus')) {
            this.denv.client.realClient.user.setActivity("*Paused*", {type: ActivityType.Playing});
        }
        
        this._pause = [this._play, pausetime];
        this._play = null;
        this._seek = 0;
        this._audioPlayer.stop();
        
        this._expirepause = setTimeout(() => (async () => {
            this.log('Expiring paused song: ' + this._pause[0].hash);
            await this.stopSong();
            this._expirepause = null;
        })(), this.param('pause') > 0 ? this.param('pause') * 1000 : 1);
    }
    
    async resumeSong() {
        if (!this._pause) return false;
        
        this.log('Preparing to resume song: ' + this._pause[0].hash + ' at ' + this._pause[1]);
        
        let song = this._pause[0];
        let seek = this._pause[1];
        
        this._pause = null;
        
        if (!await this.grabber.hashSong(song.hash)) {
            this.log('The song no longer exists.');
            return this.stopSong();
        }
        
        await this.playSong(song, seek);
        
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
    
    async dequeue(getrequester) {
        let listeners = this.listeners.map((listener) => listener.id);
    
        let usequeue = (this._queue.length ? random.fraction() < this.param('pri.queue.chance') : false);
        let novelties = await this.isThereANovelty(listeners);
        let usenovelty = (novelties ? random.fraction() < this.param('pri.novelty.chance') : false);

        let priorities = {}, tostats = {};
        for (let hash of await this.grabber.everySong()) {
            let priority = await this.songPriority(await this.grabber.hashSong(hash), listeners, usequeue, usenovelty);
            priorities[hash] = priority;
            tostats[hash] = priority.toNumber();
        }

        await this.grabber.setAdditionalStats(this.metaprefix + '.latestpriorities', tostats);
        await this.grabber.setAdditionalStats(this.metaprefix + '.latestnovelties', novelties || []);
        
        let sum = N(0);
        let candidates = [];
        for (let hash in priorities) {
            if (!priorities[hash]) continue;
            sum = sum.add(priorities[hash]);
            candidates.push([hash, sum]);
        }
        
        if (!candidates.length) return null;
        
        let pick = N(randomInt(sum.mul(PRIORITY_MAX_PRECISION_DECIMALS).floor().toNumber())).div(PRIORITY_MAX_PRECISION_DECIMALS);
        let selection = null;
        for (let item of candidates) {
            selection = item;
            if (pick.lt(item[1])) break;
        }
        if (!selection) selection = candidates[candidates.length - 1];
        
        let hash = selection[0];
        
        let index = this._queue.findIndex(item => item.song.hash == hash);
        let userid = null;
        if (index > -1) {
            userid = this._queue[index].userid;
            this._lastreq[hash] = moment().unix();
            this._queue.splice(index, 1);
            await this.grabber.setAdditionalStats(this.metaprefix + '.queue', this._queue);
        }
        
        if (getrequester) {
            return [await this.grabber.hashSong(hash), userid];
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
                    members.get(userid).voice.setDeaf(false);
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
    
    async remember(song) {
        this._history.unshift(song);
        if (this._history.length > this.param('historysize')) {
            this._history = this._history.slice(0, this.param('historysize'));
        }
        
        let plays = (await this.grabber.getSongMeta(song.hash, this.metaprefix + ".plays") || 0) + 1;
        let now = moment().unix();

        await this.grabber.setSongMeta(song.hash, this.metaprefix + ".lastplayed", now);
        await this.grabber.setSongMeta(song.hash, this.metaprefix + ".plays", plays);

        let skipdata = await this.grabber.getSongMeta(song.hash, this.metaprefix + ".skipped");
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
        await this.grabber.setSongMeta(song.hash, this.metaprefix + ".skipped", skipdata);

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
    
    
    async unanimousOpinion(hash, listeners, likeability) {
        if (!this.songrank) return false;
        for (let listener of listeners) {
            let listenerlik = await this.songrank.getSongLikeability(hash, listener);
            if (listenerlik === null || listenerlik === undefined || likeability > 0 && listenerlik < likeability || likeability < 0 && listenerlik > likeability) {
                return false;
            }
        }
        return true;
    }

    async calculateListenerSlide(listener) {  //:N
        if (!this.songrank) return N(0);
        let userhistory = this._history.slice(0, this._userlistened[listener] || 0);

        let curators = {};
        if (!this._userdata[listener] || !this._userdata[listener].curators) curators[listener] = true;
        else curators = this._userdata[listener].curators;

        let slide = N(0);
        for (let i = 0; i < userhistory.length; i++) {
            let song = userhistory[i];

            let comp = N(0);
            if (Object.keys(curators).length) {
                for (let curator in curators) {
                    comp = comp.add(N(await this.songrank.computeSongRank(song.hash, [curator]) || 0).mul(curators[curator] ? 1 : -1));
                }
                comp = comp.div(Object.keys(curators).length);
            }

            if (comp.lte(0)) comp = comp.sub(0.5);
            comp = comp.mul(-1).mul(pow(N(userhistory.length - i).mul(this.param('pri.listen.historysc')), this.param('pri.listen.history'), DECIMALS));
            slide = slide.add(comp);
        }
        return slide;
    }

    async playsRank(hash) {
        let songs = await this.grabber.everySong();
        if (Object.keys(this._playscache).length != songs.length) {
            for (let songhash of songs) {
                if (!this._playscache[songhash]) {
                    this._playscache[songhash] = (await this.grabber.getSongMeta(songhash, this.metaprefix + ".plays") || 0);
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

    async calculateSkipMitigation(hash, listener, skipdata, now) {  //:N
        if (!skipdata) skipdata = await this.grabber.getSongMeta(hash, this.metaprefix + ".skipped") || {};
        if (!now) now = moment().unix();
        
        let mostrecent = 0;
        for (let ts in skipdata) {
            if (ts > mostrecent && now - ts < this.param('pri.listen.skiprange') && skipdata[ts].findIndex(skipper => skipper == listener) > -1) {
                mostrecent = ts;
            }
        }

        if (!mostrecent) return N(1);

        return pow(N(now - mostrecent).div(this.param('pri.listen.skiprange')), this.param('pri.listen.skipbias'), DECIMALS).mul(1 - this.param('pri.listen.skipfact')).add(this.param('pri.listen.skipfact'));
    }

    async isNovelty(hash, songcount) {
        if (!songcount) songcount = (await this.grabber.everySong()).length;
        let seen = await this.grabber.getSongMeta(hash, "seen");
        if (!seen || moment().unix() - seen[0] > this.param('pri.novelty.duration')) return false;
        if ((await this.grabber.getSongMeta(hash, this.metaprefix + ".plays") || 0) > this.param("pri.novelty.breaker")) return false;
        return true;
    }

    async isThereANovelty(listeners) {
        let everysong = await this.grabber.everySong();
        let songrank = this.songrank;
        let novelties = [];
        for (let hash of everysong) {
            if (await this.isNovelty(hash, everysong.length)) {

                let voted = 0;
                if (songrank && listeners) {
                    for (let listenerid of listeners) {
                        if (await songrank.getSongLikeability(hash, listenerid)) {
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

    
    async songPriority(song, listeners, usequeue, usenovelty, trace) {  //:N
        let priority = N(this.param('pri.base'));
        let components = {base: priority};
        let songcount = (await this.grabber.everySong()).length;
        let now = moment().unix();
        
        let prelisteners = (listeners || []);
        listeners = [];
        for (let userid of prelisteners) {
            if (this._nopreference[userid]) continue;
            listeners.push(userid);
        }

        let skipdata = await this.grabber.getSongMeta(song.hash, this.metaprefix + ".skipped") || {};
        
        
        //Rank-based components
        
        let songrank = this.songrank;
        
        if (songrank) {
            //Global rank
            let calcrank = await songrank.computeSongRank(song.hash, null, true);
            let crank = N(String(calcrank.rank) || 0);
            if (calcrank.users.length) crank = crank.div(calcrank.users.length);
            crank = crank.mul(this.param('pri.rank'));
            priority = priority.add(crank);
            if (trace) components.rank = crank;
            
            //Listener components
            if (listeners.length) {
                let clisten = N(0);

                for (let listener of listeners) {
                    let curated = N(0);

                    //Base rank for each listener (from curators)
                    let curators = {};
                    if (!this._userdata[listener] || !this._userdata[listener].curators) curators[listener] = true;
                    else curators = this._userdata[listener].curators;
                    if (!Object.keys(curators).length) continue;

                    for (let curator in curators) {
                        curated = curated.add(N(String(await songrank.computeSongRank(song.hash, [curator])) || 0).mul(curators[curator] ? 1 : -1));
                    }
                    curated = curated.div(Object.keys(curators).length);
                    curated = curated.mul(this.param('pri.listen'));
                    curated = curated.div(listeners.length);

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

                    if (curated.gt(0) && keywordspos.length && !posfound || curated.lt(0) && posfound) {
                        curated = curated.mul(this.param('pri.listen.nopos'));
                    }
                    if (curated.gt(0) && negfound || curated.lt(0) && keywordsneg.length && !negfound) {
                        curated = curated.mul(this.param('pri.listen.yesneg'));
                    }

                    if (trace) components["withkeywords." + listener] = curated;

                    //Skip attenuation
                    if (curated.gt(0)) {
                        let skipfactor = await this.calculateSkipMitigation(song.hash, listener, skipdata, now);
                        curated = curated.mul(skipfactor);
                        if (trace && skipfactor.lt(1)) components["withskips." + listener] = curated;
                    }

                    clisten = clisten.add(curated);
                }

                //Slide
                for (let listener of listeners) {
                    let slide = await this.calculateListenerSlide(listener);
                    if (trace) components["slide." + listener] = slide;
                    clisten = clisten.mul(slide.gt(1) ? slide.pow(this.param('pri.listen.slide')) : 1);
                }

                priority = priority.add(clisten);
                if (trace) components.listen = clisten;
            }
        }
                
        
        //Proximity to optimal length
        
        let clength = N(0);
        if (song.length >= this.param('pri.length.minlen') && song.length <= this.param('pri.length.maxlen')) {
            clength = N(this.param('pri.length'));
        } else if (song.length > this.param('pri.length.maxlen') && song.length < this.param('pri.length.maxexcs')) {
            clength = N(this.param('pri.length')).mul(N(this.param('pri.length.maxexcs') - song.length).div(this.param('pri.length.maxexcs') - this.param('pri.length.maxlen')));
        } else if (song.length < this.param('pri.length.minlen')) {
            clength = N(this.param('pri.length')).mul(N(song.length).div(this.param('pri.length.minlen')));
        }
        priority = priority.add(clength);
        if (trace) components.length = clength;


        //Low plays
        
        let plays = song[this.metaprefix + ".plays"] || 0;
        let clowplays = N(N(1).sub(N(Math.min(this.param('pri.lowplays.max'), plays)).div(this.param('pri.lowplays.max')))).mul(this.param('pri.lowplays'));
        priority = priority.add(clowplays);
        if (trace) components.lowplays = clowplays;


        //Comparative plays

        if (priority.lt(0)) priority = N(0);
        if (trace) components.baseabsolute = priority;
        let playsrank = await this.playsRank(song.hash);
        let playsfactor = log(playsrank + 1, DECIMALS).div(log(N(1).add(N(songcount).mul(this.param('pri.mitigatedslice'))), DECIMALS));
        if (trace) components.playsfactor = playsfactor;
        priority = pow(priority, playsfactor, DECIMALS);
        if (trace) components.withplays = priority;


        //Recently played song mitigation
        
        let recentgradient = N(Math.min(now - (song[this.metaprefix + ".lastplayed"] || 0), this.param('pri.recent'))).div(this.param('pri.recent'));
        priority = priority.mul(recentgradient);
        if (trace) components.withrecent = priority;


        //Unanimous dislike penalties
        
        if (listeners.length) {
            let upenalty = null;
            if (await this.unanimousOpinion(song.hash, listeners, -2)) {
                upenalty = priority.mul(N(1).sub(this.param('pri.unanimous.hate')));
                priority = priority.sub(upenalty);
                if (trace) components.unanimoushate = upenalty;
            } else if (await this.unanimousOpinion(song.hash, listeners, -1)) {
                upenalty = priority.mul(N(1).sub(this.param('pri.unanimous.meh')));
                priority = priority.sub(upenalty);
                if (trace) components.unanimousdislike = upenalty;
            }
        }


        //Queue

        if (usequeue && this._queue.length) {
            let queuepos = this._queue.findIndex(item => item.song.hash == song.hash);
            if (queuepos > -1) {
                priority = N(this.param('queuesize') - queuepos).div(this.param('queuesize'));
                if (trace) components.queuereset = priority;
            } else {
                priority = N(0);
                if (trace) components.queuereset = priority;
            }

        }


        //Novelty

        if (usenovelty && !await this.isNovelty(song.hash, songcount)) {
            priority = N(0);
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
