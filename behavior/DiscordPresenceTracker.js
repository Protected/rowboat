/* DiscordPresenceTracker -- Announces updates to user presence in a Discord channel. */

import moment from 'moment';
import { EmbedBuilder, ActivityType } from 'discord.js';

import Behavior from '../src/Behavior.js';

export default class DiscordPresenceTracker extends Behavior {

    get params() { return [
        {n: "channelid", d: "ID of the channel where the updates will be sent"},
        {n: "roleid", d: "ID of an optional role required for being tracked"},
        {n: "activities", d: "List of tracked activities (see discord API docs)"},
        {n: "actinfo", d: "Activity descriptors: {NAME: {filter: {...}, fieldTitle, fieldLabels: {...}, online, color}, ...}"},
        {n: "reconnecttolerance", d: "How long until a disconnection becomes valid to be announced (s)"},
        {n: "reconnectchecktimer", d: "How often to validate disconnections (s)"},
        {n: "usewebhook", d: "Whether to use a temporary webhook for announcements"}
    ]; }

    get defaults() { return {
        roleid: null,
        activities: ["twitch"],
        actinfo: {
            twitch: {
                //Match every field in Activity to identify this activity
                filter: {name: "Twitch", type: ActivityType.Streaming},
                //Activity title
                fieldTitle: "details",
                //Used Activity fields and their display labels
                fieldLabels: {details: "Title", state: "Game"},
                //Messages
                online: "Now streaming on Twitch!",
                offline: "Stream is now offline.",
                //Embed accent color
                color: "#593695"
            }
        },
        reconnecttolerance: 180,
        reconnectchecktimer: 61,
        usewebhook: true
    }; }

    get requiredEnvironments() { return {
        Discord: "Discord"
    }; }

    get isMultiInstanceable() { return true; }
    
    get denv() {
        return this.env("Discord");
    }

    get announcechan() {
        return this.denv.server.channels.cache.get(this.param("channelid"));
    }

    constructor(name) {
        super('DiscordPresenceTracker', name);

        this._pendingoffline = {};  //{userid: {ACTIVITY: TS, ...}, ...}
        this._timer = null;
    }

    initialize(opt) {
        if (!super.initialize(opt)) return false;

        let presenceUpdateHandler = (oldPresence, presence) => {
            if (this.param("roleid") && !presence.member.roles.cache.get(this.param("roleid"))) return;
            let now = moment().unix();

            for (let name of this.param("activities")) {
                let oldActivity = (oldPresence ? this.presenceGetActivity(oldPresence, name) : null);
                let activity = (presence ? this.presenceGetActivity(presence, name) : null);

                if (!oldActivity && !activity) continue;
                let info = this.actinfo(name);

                if (!oldActivity && activity) {
                    if (!this.isPendingOffline(presence.userId, name)) {
                        this.activityStart(presence.member, info, activity);
                    }
                    this.clearOffline(presence.userId, name);
                }
                if (oldActivity && activity) {
                    this.activityUpdate(presence.member, info, oldActivity, activity);
                }
                if (oldActivity && !activity) {
                    this.scheduleOffline(presence.userId, name, now);
                }
            }

        }

        this.denv.on("connected", async () => {
            this.denv.client.on("presenceUpdate", presenceUpdateHandler);
        });

        this._timer = setInterval(async function () {
            let now = moment().unix();

            for (let userid in this._pendingoffline) {
                let member = null;
                for (let name in this._pendingoffline[userid]) {
                    if (this.isPendingOffline(userid, name, now)) continue;
                    if (!member) member = await this.denv.server.members.fetch(userid);
                    this.activityEnd(member, this.actinfo(name));
                    this.clearOffline(userid, name);
                }
            }

        }.bind(this), this.param("reconnectchecktimer") * 1000);

      
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

    scheduleOffline(userid, activityname, now) {
        if (!userid || !activityname) return false;
        if (!now) now = moment().unix();
        if (!this._pendingoffline[userid]) {
            this._pendingoffline[userid] = {};
        }
        this._pendingoffline[userid][activityname] = now;
        return true;
    }

    clearOffline(userid, activityname) {
        if (!userid || !activityname || !this._pendingoffline[userid]) return false;
        if (this._pendingoffline[userid][activityname]) {
            delete this._pendingoffline[userid][activityname];
        }
        if (!Object.keys(this._pendingoffline[userid]).length) {
            delete this._pendingoffline[userid];
        }
        return true;
    }

    isPendingOffline(userid, activityname, now) {
        if (!userid || !activityname || !this._pendingoffline[userid]) return false;
        if (!now) now = moment().unix();
        return this._pendingoffline[userid][activityname] && now - this._pendingoffline[userid][activityname] < this.param("reconnecttolerance");
    }
    
    activityStart(member, info, activity) {
        let embed = new EmbedBuilder();
        
        if (!this.param("usewebhook")) {
            embed.setAuthor({name: member.displayName, iconURL: member.user.displayAvatarURL()});
        }

        embed.setColor(info.color);
        embed.setTitle(activity[info.fieldTitle]);

        if (activity.url) {
            embed.setURL(activity.url);
        }
        
        let image = activity.assets.largeImageURL() || activity.assets.smallImageURL();
        if (image) {
            embed.setThumbnail(image);
        }

        for (let field in info.fieldLabels) {
            if (field == info.fieldTitle) continue;
            embed.addFields({name: info.fieldLabels[field], value: activity[field]});
        }

        embed.setDescription(info.online);

        if (this.param("usewebhook")) {
            this.denv.getWebhook(this.announcechan, member).then((webhook) => webhook.send({embeds: [embed]}));
        } else {
            this.denv.msg(this.announcechan, embed);
        }
    }

    activityUpdate(member, info, oldActivity, activity) {
        let embed = new EmbedBuilder();
        
        if (!this.param("usewebhook")) {
            embed.setAuthor({name: member.displayName, iconURL: member.user.displayAvatarURL()});
        }

        embed.setColor(info.color);

        let changes = [];
        for (let field in info.fieldLabels) {
            if (oldActivity[field] != activity[field]) {
                changes.push("**" + info.fieldLabels[field] + "**: " + oldActivity[field] + " ➡️ " + activity[field]);
            }
        }

        if (changes.length) {
            embed.setDescription(changes.join("\n"));
            if (this.param("usewebhook")) {
                this.denv.getWebhook(this.announcechan, member).then((webhook) => webhook.send({embeds: [embed]}));
            } else {
                this.denv.msg(this.announcechan, embed);
            }
        }
    }

    activityEnd(member, info) {
        let embed = new EmbedBuilder();
        
        if (!this.param("usewebhook")) {
            embed.setAuthor({name: member.displayName, iconURL: member.user.displayAvatarURL()});
        }
        
        embed.setDescription(info.offline);

        if (this.param("usewebhook")) {
            this.denv.getWebhook(this.announcechan, member).then((webhook) => webhook.send({embeds: [embed]}));
        } else {
            this.denv.msg(this.announcechan, embed);
        }
    }


}
