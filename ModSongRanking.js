/* Module: SongRanking -- Grabber add-on for liking/disliking songs and rating them. */

var Module = require('./Module.js');
var emoji = require('emojione');
var random = require('meteor-random');

var LIKEABILITY_WORDS = {
    love: 2,
    adore: 2,
    blissful: 2,
    enraptured: 2,
    epiphany: 2,
    wow: 2,
    incredible: 2,
    ok: 1,
    like: 1,
    decent: 1,
    happy: 1,
    acceptable: 1,
    yes: 1,
    sure: 1,
    mediocre: -1,
    dislike: -1,
    unhappy: -1,
    unimpressed: -1,
    underwhelming: -1,
    no: -1,
    nah: -1,
    nope: -1,
    hate: -2,
    horrible: -2,
    terrible: -2,
    disgust: -2,
    never: -2,
    poop: -2
};

var LIKEABILITY_REACTIONS = {
    ok_hand: 2,
    thumbsup: 2,
    clap: 2,
    laughing: 2,
    satisfied: 2,
    heart_eyes: 2,
    heart: 2,
    hearts: 2,
    smile: 1,
    smiley: 1,
    slight_smile: 1,
    grin: 1,
    grinning: 1,
    relieved: 1,
    relaxed: 1,
    metal: 1,
    weary: -1,
    slight_frown: -1,
    expressionless: -1,
    unamused: -1,
    disappointed: -1,
    worried: -1,
    frowning: -1,
    anguished: -1,
    sleepy: -1,
    grimacing: -1,
    poop: -2,
    rage: -2,
    thumbsdown: -2,
    nauseated_face: -2,
    sick: -2
}


class ModSongRanking extends Module {

    
    get isMultiInstanceable() { return true; }
    
    get requiredParams() { return [
        'env',                  //Name of the Discord environment to be used
        'channels',             //List of IDs of the Discord channels to be used
        'grabber'               //Name of the grabber to piggyback on (required because the grabber is multi-instanceable)
    ]; }
    
    get optionalParams() { return [
        'scaleExtremists'       //Scale down -2/2 votes of people who have more than X times as many of those votes as -1/1 votes
    ]; }
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('SongRanking', name);
        
        this._params['scaleExtremists'] = 1.0;
        
        this._index = {};  //{USERID: {LIKEABILITY: [HASH, ...], ...}, ...}
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') return false;
        
        
        //Build index
        
        for (let hash of this.grabber.everySong()) {
            let likmap = this.grabber.getSongMeta(hash, "like");
            for (let userid in likmap) {
                if (!this._index[userid]) this._index[userid] = {};
                if (!this._index[userid][likmap[userid]]) this._index[userid][likmap[userid]] = [];
                this._index[userid][likmap[userid]].push(hash);
            }
        }
 
        
        //Register callbacks

        var self = this;

        this.grabber.registerOnNewSong((messageObj, messageAuthor, reply, hash) => {
            
            this.setSongLikeability(hash, messageObj.author.id, 1);
            
        }, self);

        this.grabber.registerOnGrabscanExists((messageObj, messageAuthor, reply, hash) => {

            for (let messageReaction of messageObj.reactions.array()) {
                let emojiname = '';
                let extr = emoji.toShort(messageReaction.emoji.name).match(/\:([^:]+)\:/);
                if (!extr) continue;
                emojiname = extr[1];
                if (LIKEABILITY_REACTIONS[emojiname] === undefined) continue;
                
                let likeability = LIKEABILITY_REACTIONS[emojiname];
                if (this.getSongLikeability(hash, messageObj.author.id) === likeability) continue;
                
                this.setSongLikeability(hash, messageObj.author.id, likeability);
            }
            
        }, self);
        
        
        this.denv.on('connected', (env) => {
        
            env.client.on('messageReactionAdd', (messageReaction, user) => {
                if (!messageReaction.message.channel || messageReaction.message.channel.guild.id != env.server.id) return;
                
                let emojiname = '';
                let extr = emoji.toShort(messageReaction.emoji.name).match(/\:([^:]+)\:/);
                if (!extr) return;
                emojiname = extr[1];
                if (LIKEABILITY_REACTIONS[emojiname] === undefined) return;
                
                this.grabber.scanMessage(messageReaction.message, {
                    exists: (messageObj, messageAuthor, reply, hash) => {
                        this.setSongLikeability(hash, user.id, LIKEABILITY_REACTIONS[emojiname]);
                    }
                }, true);
            });
            
        }, self);
        
        
        //Register module integrations
        
        this.grabber.registerParserFilter(/^£(-?[12])?$/, (str, match, userid) => {
            if (!userid) return null;
            let likeability = (match[1] || 0);
            if (!likeability) return this.grabber.randomSong().hash;
            if (!this._index[userid] || !this._index[userid][likeability] || !this._index[userid][likeability].length) return null;
            return this._index[userid][likeability][Math.floor(random.fraction() * this._index[userid][likeability].length)];
        }, this);
        
        
        //Register commands
        
        this.mod('Commands').registerRootExtension(this, 'Grabber', 'song');
        
        
        this.mod('Commands').registerCommand(this, 'song like', {
            description: 'Assigns a personal like level to a song in the index.',
            args: ['hashoroffset', 'likeability'],
            details: [
                "Likeability can be one of:",
                " 2 = :ok_hand: = I especially like the song",
                " 1 = :slight_smile: = (default) The song is ok/good",
                "-1 = :worried: = The song is bad/don't like it much",
                "-2 = :poop: = I hate this song"
            ],
            minArgs: 1
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (env.name != this.param('env')) return true;
            
            var hash = this.grabber.bestSongForHashArg(args.hashoroffset);
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
        
            var lik = args.likeability || 1;
            lik = parseInt(lik);
            if (isNaN(lik)) {
                if (LIKEABILITY_WORDS[args.likeability] !== undefined) lik = LIKEABILITY_WORDS[args.likeability];
                else lik = 1;
            }
            if (lik < -2) lik = -2;
            if (lik > 2) lik = 2;
            
            if (lik == 0) {
                ep.reply('?');
                return true;
            }
        
            if (this.setSongLikeability(hash, userid, parseInt(lik))) {
                ep.reply("Ok.");
            } else {
                ep.reply("Song not found or invalid argument.");
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'song rank', {
            description: 'Displays the global (balanced) rank of a song.',
            args: ['hashoroffset']
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            var hash = this.grabber.bestSongForHashArg(args.hashoroffset);
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
        
            var rank = this.computeSongRank(hash);
            if (rank !== null) {
                ep.reply("Rank: " + rank);
            } else {
                ep.reply("Song is unranked.");
            }
        
            return true;
        });


        return true;
    }
    
    
    // # Module code below this line #
    
    
    setSongLikeability(hash, userid, likeability) {
        this.log('Setting ' + userid + ' likeability of ' + hash + ' to ' + likeability);
        
        //Add new likeability to songrank index
        if (!this._index[userid]) this._index[userid] = {};
        if (!this._index[userid][likeability]) this._index[userid][likeability] = [];
        this._index[userid][likeability].push(hash);
        
        //Fetch likeabilities of song
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) likmap = {};
        
        //Remove old likeability from songrank index if necessary
        if (likmap[userid] && likmap[userid] != likeability) {
            this._index[userid][likmap[userid]] = this._index[userid][likmap[userid]].filter((item) => item != hash);
        }
        
        //Update likeabilities of song
        likmap[userid] = likeability;        
        return this.grabber.setSongMeta(hash, "like", likmap);
    }
    
    
    getSongLikeability(hash, userid) {
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return null;
        return likmap[userid];
    }
    
    
    computeSongRank(hash, users) {  //users is a list of Discord userids
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) return null;
        if (!users || !users.length) {
            users = Object.keys(likmap);
        }
        
        var i = 0; 
        var acc = 0;
        for (let userid of users) {
            let scale = 1.0;
            let likeability = (likmap[userid] || 0);
            
            let elength = 0, clength = 0;
            if (likeability == -2) {
                if (this._index[userid][-2]) elength = this._index[userid][-2].length;
                if (this._index[userid][-1]) elength = this._index[userid][-1].length;
            }
            if (likeability == 2) {
                if (this._index[userid][2]) elength = this._index[userid][2].length;
                if (this._index[userid][1]) elength = this._index[userid][1].length;
            }
            if (elength && elength > clength * this.param('scaleExtremists')) {
                scale = clength * this.param('scaleExtremists') / elength;
            }
            
            if (likeability > 0) likeability = (likeability - 1) * scale + 1;
            if (likeability < 0) likeability = (likeability + 1) * scale - 1;
        
            acc += likeability;
            i += 1;
        }
        
        if (!i) return null;
        //acc /= i;
        return acc;
    }
    
    
}


module.exports = ModSongRanking;
