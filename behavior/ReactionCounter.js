/* Module: ReactionCounter -- Ranks Discord channel messages by reactions. */

const random = require('meteor-random');

const Module = require('../Module.js');

const PERM_ADMIN = 'administrator';

class ModReactionCounter extends Module {

    get requiredParams() { return [
    ]; }
    
    get optionalParams() { return [
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
        'Commands',
    ]; }

    constructor(name) {
        super('ReactionCounter', name);
     
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //# Register commands

        this.mod('Commands').registerCommand(this, 'recount', {
            description: "Lists the top messages with the most reactions of the given emoji.",
            details: [
                "Returns the top 3 by default."
            ],
            args: ["channelid", "emoji", "amount"],
            minArgs: 2,
            permissions: [PERM_ADMIN]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            let channel = env.server.channels.cache.get(args.channelid);
            if (!channel) {
                ep.reply("Channel not found.");
                return true;
            }

            let amount = args.amount || 3;
            if (amount < 1) amount = 1;

            let counts = [];

            env.scanEveryMessage(channel, (message) => {
                let reaction = message.reactions.cache.find(reaction => reaction.emoji.name == args.emoji);
                counts.push({msg: message.id, count: reaction ? reaction.count : 0});
            }, () => {
                counts.sort((a, b) => a.count != b.count ? b.count - a.count : random.fraction() - 0.5);
                counts.slice(amount);
                ep.reply("**__Top " + amount + ":__**");
                let i = 1;
                for (let item of counts) {
                    ep.reply("**" + i + ".** https://discord.com/channels/" + env.server.id + "/" + channel.id + "/" + item.msg);
                    i += 1;
                }
            });

            return true;
        });

        
        return true;
    };



    // # Module code below this line #


}


module.exports = ModReactionCounter;
