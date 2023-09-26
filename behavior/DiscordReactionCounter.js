/* ReactionCounter -- Ranks Discord channel messages by reactions. */

import random from 'meteor-random';

import Behavior from '../src/Behavior.js';

export default class DiscordReactionCounter extends Behavior {

    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('DiscordReactionCounter', name);
     
    }
    
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //# Register commands

        const permAdmin = this.be('Users').defaultPermAdmin;

        this.be('Commands').registerCommand(this, 'recount', {
            description: "Lists the top messages with the most reactions of the given emoji.",
            details: [
                "Returns the top 3 by default."
            ],
            args: ["channelid", "emoji", "amount"],
            minArgs: 2,
            permissions: [permAdmin]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (env.name !== this.env('Discord').name) return true;

            let channel = env.server.channels.cache.get(env.extractChannelId(args.channelid));
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
                counts = counts.slice(0, amount);
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
