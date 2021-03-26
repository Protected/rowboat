/* Module: DiscordPresenceTracker -- Announces updates to user presence in a Discord channel. */

const { MessageEmbed } = require('discord.js');
const Module = require('../Module.js');

class ModDiscordPresenceTracker extends Module {

    get isMultiInstanceable() { return true; }

    get requiredParams() { return [
        "env",
        "channelid"
    ]; }

    get optionalParams() { return [
        "roleid",               //Optional role required for being tracked
        "activities",           //List of tracked activities
        "actinfo"               //Activity descriptors: {NAME: {filter: {...}, description, fieldTitle, fieldLabels: {...}, color}, ...}
    ]; }

    get requiredEnvironments() { return [
        'Discord'
    ]; }

    get requiredModules() { return [
    ]; }
    
    get denv() {
        return this.env(this.param('env'));
    }

    get announcechan() {
        return this.denv.server.channels.cache.get(this.param("channelid"));
    }

    constructor(name) {
        super('DiscordPresenceTracker', name);

        this._params["activities"] = ["twitch"];

        this._params["actinfo"] = {
            twitch: {
                //Match every field in Activity to identify this activity
                filter: {name: "Twitch", type: "STREAMING"},
                //Activity title
                fieldTitle: "details",
                //Used Activity fields and their display labels
                fieldLabels: {details: "Title", state: "Game"},
                //Embed accent color
                color: "#593695"
            }
        };

    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let presenceUpdateHandler = (oldPresence, presence) => {
            if (this.param("roleid") && !presence.member.roles.cache.get(this.param("roleid"))) return;

            for (let name of this.param("activities")) {
                let oldActivity = (oldPresence ? this.presenceGetActivity(oldPresence, name) : null);
                let activity = (presence ? this.presenceGetActivity(presence, name) : null);

                if (!oldActivity && !activity) continue;
                let info = this.actinfo(name);

                if (!oldActivity && activity) this.activityStart(presence.member, info, activity);
                if (oldActivity && activity) this.activityUpdate(presence.member, info, oldActivity, activity);
                if (oldActivity && !activity) this.activityEnd(oldPresence.member, info, oldActivity);
            }

        }

        this.denv.on("connected", async () => {
            this.denv.client.on("presenceUpdate", presenceUpdateHandler);
        });

      
        return true;
    };
    
    
    // # Module code below this line #

    actinfo(name) {
        return this.param("actinfo")[name];
    }

    activityIs(activity, name) {
        if (!activity || !name) return false;
        for (let field in this.actinfo(name).filter) {
            if (this.actinfo(name).filter[field] != activity[field]) {
                return false;
            }
        }
        return true;
    }

    presenceGetActivity(presence, name) {
        if (!presence) return null;
        for (let activity of presence.activities) {
            if (this.activityIs(activity, name)) {
                return activity;
            }
        }
        return null;
    }
    
    activityStart(member, info, activity) {
        let embed = new MessageEmbed();
        embed.setAuthor(member.displayName, member.user.displayAvatarURL());
        embed.setColor(info.color);

        embed.setTitle(activity[info.fieldTitle]);

        if (activity.url) {
            embed.setURL(activity.url);
        }
        
        let image = activity.assets.smallImageURL() || activity.assets.largeImageURL();
        if (image) {
            embed.setThumbnail(image);
        }

        for (let field in info.fieldLabels) {
            if (field == info.fieldTitle) continue;
            embed.addField(info.fieldLabels[field], activity[field]);
        }

        embed.setDescription("Now online!");

        this.announcechan.send(embed);
    }

    activityUpdate(member, info, oldActivity, activity) {
        let embed = new MessageEmbed();
        embed.setAuthor(member.displayName, member.user.displayAvatarURL());
        embed.setColor(info.color);

        let changes = [];
        for (let field in info.fieldLabels) {
            if (oldActivity[field] != activity[field]) {
                changes.push("**" + info.fieldLabels[field] + "**: " + oldActivity[field] + " ➡️ " + activity[field]);
            }
        }

        if (changes.length) {
            embed.setDescription(changes.join("\n"));
            this.announcechan.send(embed);
        }
    }

    activityEnd(member, info, activity) {
        let embed = new MessageEmbed();
        embed.setAuthor(member.displayName, member.user.displayAvatarURL());
        
        embed.setDescription("Now offline.");

        this.announcechan.send(embed);
    }


}


module.exports = ModDiscordPresenceTracker;

