/* Module: SongRanking -- Grabber add-on for liking/disliking songs and rating them. */

var Module = require('./Module.js');
var emoji = require('emojione');

var LIKEABILITY_WORDS = {
    love: 1,
    adore: 1,
    blissful: 1,
    enraptured: 1,
    epiphany: 1,
    wow: 1,
    incredible: 1,
    ok: 0,
    like: 0,
    decent: 0,
    happy: 0,
    acceptable: 0,
    yes: 0,
    mediocre: -1,
    dislike: -1,
    unhappy: -1,
    unimpressed: -1,
    underwhelming: -1,
    no: -1,
    hate: -2,
    horrible: -2,
    terrible: -2,
    disgust: -2,
    never: -2
};

var LIKEABILITY_REACTIONS = {
    ok_hand: 1,
    thumbsup: 1,
    clap: 1,
    laughing: 1,
    satisfied: 1,
    heart_eyes: 1,
    heart: 1,
    hearts: 1,
    smile: 0,
    smiley: 0,
    slight_smile: 0,
    grin: 0,
    grinning: 0,
    relieved: 0,
    relaxed: 0,
    metal: 0,
    slight_frown: -1,
    expressionless: -1,
    unamused: -1,
    disappointed: -1,
    worried: -1,
    frowning: -1,
    anguished: -1,
    sleepy: -1,
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
    
    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands'
    ]; }

    constructor(name) {
        super('SongRanking', name);        
    }
    
    
    get grabber() {
        return this.mod(this.param('grabber'));
    }
    
    get denv() {
        return this.env(this.param('env'));
    }    
    
    initialize(envs, mods, moduleRequest) {
        if (!super.initialize(envs, mods, moduleRequest)) return false;

        if (!this.grabber || this.grabber.modName != 'Grabber') return false;
        
        
        //Register callbacks

        var self = this;

        this.grabber.registerOnNewSong((messageObj, messageAuthor, reply, hash) => {
            
            this.setSongLikeability(hash, messageObj.author.id, 0);
            
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
                let emojiname = '';
                let extr = emoji.toShort(messageReaction.emoji.name).match(/\:([^:]+)\:/);
                if (!extr) return;
                emojiname = extr[1];
                if (LIKEABILITY_REACTIONS[emojiname] === undefined) return;
                
                this.grabber.scanMessage(messageReaction.message, {
                    exists: (messageObj, messageAuthor, reply, hash) => {
                        this.setSongLikeability(hash, messageReaction.message.author.id, LIKEABILITY_REACTIONS[emojiname]);
                    }
                }, true);
            });
            
        }, self);
        
        
        this.mod('Commands').registerCommand(this, 'songlike', {
            description: 'Assigns a personal like level to a song in the index.',
            args: ['hashoroffset', 'likeability'],
            details: [
                "Likeability can be one of:",
                " 1 = :ok_hand: = I especially like the song",
                " 0 = :slight_smile: = (default) The song is ok/good",
                "-1 = :slight_frown: = The song is bad/don't like it much",
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
        
            var lik = args.likeability || 0;
            lik = parseInt(lik);
            if (isNaN(lik)) {
                if (LIKEABILITY_WORDS[args.likeability] !== undefined) lik = LIKEABILITY_WORDS[args.likeability];
                else lik = 0;
            }
            if (lik < -2) lik = -2;
            if (lik > 1) lik = 1;
        
            if (this.setSongLikeability(hash, userid, parseInt(lik))) {
                ep.reply("Ok.");
            } else {
                ep.reply("Song not found or invalid argument.");
            }
        
            return true;
        });
        
        
        this.mod('Commands').registerCommand(this, 'songrank', {
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
        var likmap = this.grabber.getSongMeta(hash, "like");
        if (!likmap) likmap = {};
        likmap[userid] = likeability;
        this.log('Setting ' + userid + ' likeability of ' + hash + ' to ' + likeability);
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
        for (let userid in likmap) {
            if (users.indexOf(userid) > -1) {
                acc += likmap[userid];
                i += 1;
            }
        }
        if (!i) return null;
        acc /= i;
        return acc;
    }
    
    
}


module.exports = ModSongRanking;
