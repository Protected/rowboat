import { PermissionsBitField, ChannelType, OverwriteType } from 'discord.js';

import Behavior from '../src/Behavior.js';

const BOT_PERMS_IN_VOICE_CHAN = ["ViewChannel", "ManageChannels", "Connect", "MuteMembers", "DeafenMembers", "MoveMembers", "ManageRoles"];
const DEFAULT_MOD_PERMS_IN_VOICE_CHAN = ["ViewChannel", "ManageChannels", "PrioritySpeaker", "Stream", "Connect", "Speak", "MuteMembers", "MoveMembers"];

export default class DiscordTempVoice extends Behavior {

    get description() { return "Start a temporary voice channel for any Discord text channel"; }

    get params() { return [
        {n: 'datafile', d: "Datafile for keeping track of the temporary channels"},
        {n: 'settingsfile', d: "Datafile for module configurable settings"},
        {n: 'permissions', d: "List of bot permission templates for filtering allowed text channels; expands %env%, %parentid% and %channelid% (or true for all channels)"}
    ]; }

    get defaults() { return {
        datafile: null,
        settingsfile: null,
        permissions: true
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Users: 'Users',
        Commands: 'Commands'
    }; }

    get denv() {
        return this.env("Discord");
    }

    constructor(name) {
        super('DiscordTempVoice', name);

        this._settings = null;  //See in initialize
        this._voices = null;  //{TEXTCHANNELID: {voice: VOICECHANNELID, mod: USERID, pin: false}, ...}
        this._revindex = {};  //{VOICECHANNELID: TEXTCHANNELID}
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

        //# Load data
        
        this._settings = this.loadData(this.param('settingsfile') || this.name.toLowerCase() + ".settings.json", {
            modvoiceperms: DEFAULT_MOD_PERMS_IN_VOICE_CHAN,
        }, {pretty: true});
        if (this._settings === false) return false;

        this._voices = this.loadData(undefined, undefined, {quiet: true});
        if (this._voices === false) return false;

        //Build reverse index for loaded metadata
        for (let textchanid in this._voices) {
            this._revindex[this._voices[textchanid].voice] = textchanid;
        }


        //# Register callbacks

        let voiceStateUpdateHandler = async (oldState, state) => {
            if (state.guild.id != this.denv.server.id) return;
            if (state.id == this.denv.client.realClient.user.id) return;
            
            if (oldState.channelId != state.channelId) {

                //Delete unpinned voice channel if the last user disconnects
                let textchanid = this._revindex[oldState.channelId];
                if (textchanid && !this._voices[textchanid].pin) {
                    let voicechan = await oldState.channel.fetch();
                    if (!voicechan.members.size) {
                        this.removeVoiceChannelByVoiceId(oldState.channelId);
                    }
                }

            }

        }

        let channelDeleteHandler = (channel) => {

            if (channel.type == ChannelType.GuildText && this._voices[channel.id]) {
                //Delete voice channel if its text channel is deleted
                this.removeVoiceChannel(channel.id);
            } else if (channel.type == ChannelType.GuildVoice && this._revindex[channel.id]) {
                //Unregister voice channel if it's manually deleted
                this.unregisterVoiceChannel(this._revindex[channel.id])
            }

        }

        let channelUpdateHandler = (oldChannel, channel) => {

            if (channel.type == ChannelType.GuildText && this._voices[channel.id]) {
                
                let voicechan = this.getVoiceChannel(channel.id);

                if (oldChannel.name != channel.name) {
                    //Rename voice channel if its text channel is renamed    
                    voicechan.setName(channel.name);
                }

                if (oldChannel.parentId != channel.parentId) {
                    //Keep voice channel in same category as text channel
                    voicechan.setParent(channel.parentId);
                }

            }

            if (channel.type == ChannelType.GuildVoice && this._revindex[channel.id] && oldChannel.parentId != channel.parentId) {
                //Keep voice channel in same category as text channel
                let textchan = this.getTextChannel(channel.id);
                if (textchan && textchan.parentId != channel.parentId) {
                    channel.setParent(textchan.parentId);
                }
            }

        }


        this.denv.on("connected", async () => {

            //Check channels in metadata and clean up as needed
            for (let textchanid in this._voices) {

                let voicechan = await this.denv.server.channels.fetch(this._voices[textchanid].voice);

                if (!voicechan) {
                    //Unregister voice channel if it no longer exists
                    this.unregisterVoiceChannel(textchanid);
                    continue;
                }
                
                if (!this.denv.server.channels.cache.get(textchanid)) {
                    //Delete voice channel if its text channel no longer exists
                    this.removeVoiceChannel(textchanid);
                    continue;
                }

                if (!this._voices[textchanid].pin && !voicechan.members.size) {
                    //Delete voice channel if it's unpinned and empty
                    this.removeVoiceChannel(textchanid);
                    continue;
                }

            }

            this.denv.client.on("voiceStateUpdate", voiceStateUpdateHandler);
            this.denv.client.on("channelDelete", channelDeleteHandler);
            this.denv.client.on("channelUpdate", channelUpdateHandler);
        });


        //# Register commands

        const permAdmin = this.be('Users').defaultPermAdmin;
        const permMod = this.be('Users').defaultPermMod;
        
        this.be('Commands').registerCommand(this, 'talk', {
            description: "Start a managed voice channel for the current text channel.",
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.testEnv(env)) return true;

            let voicechannel = this.getVoiceChannel(channelid);
            if (voicechannel) return true;

            let textchannel = await this.denv.server.channels.fetch(channelid);

            if (this.ownerCheck() && !await this.be('Users').testPermissions(env.name, userid, channelid, this.ownershipPermissions(channelid, textchannel.parentId))) {
                ep.reply("You don't have permission to do that here.");
                return true;
            }
        
            this.createVoiceChannel(channelid, userid);

            return true;
        });

        this.be('Commands').registerCommand(this, 'wrapup', {
            description: "Forcefully destroy the voice channel.",
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.testEnv(env)) return true;

            let meta = this.getVoiceChannelInfo(channelid);
            if (!meta) {
                ep.reply("There is no voice channel for this text channel.");
                return true;
            }

            let textchannel = await this.denv.server.channels.fetch(channelid);

            if (this.ownerCheck() && !await this.be('Users').testPermissions(env.name, userid, channelid, this.ownershipPermissions(channelid, textchannel.parentId))) {
                ep.reply("You don't have permission to do that here.");
                return true;
            }

            this.removeVoiceChannel(channelid);
        
            return true;
        });

        this.be('Commands').registerRootDetails(this, 'vc', {description: "Commands for manipulating instantaneous temporary voice channels."});

        this.be('Commands').registerCommand(this, 'vc pin', {
            description: "Pin the voice channel so it stays open even if it's empty.",
            types: ["regular"],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.testEnv(env)) return true;

            let meta = this.getVoiceChannelInfo(channelid);
            if (!meta) {
                ep.reply("There is no voice channel for this text channel.");
                return true;
            }

            if (meta.pin) {
                ep.reply("Voice channel was already pinned.");
                return true;
            }

            meta.pin = true;
            this._voices.save();
            ep.reply("Voice channel pinned.");
        
            return true;
        });

        this.be('Commands').registerCommand(this, 'vc unpin', {
            description: "Unpin the voice channel so it disappears when it's empty.",
            types: ["regular"],
            permissions: [permAdmin, permMod]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
        
            if (!this.testEnv(env)) return true;

            let meta = this.getVoiceChannelInfo(channelid);
            if (!meta) {
                ep.reply("There is no voice channel for this text channel.");
                return true;
            }

            if (!meta.pin) {
                ep.reply("Voice channel wasn't pinned.");
                return true;
            }

            meta.pin = false;
            this._voices.save();
            ep.reply("Voice channel unpinned.");
        
            return true;
        });

        this.be('Commands').registerCommand(this, 'vc mod', {
            description: "Show or change the moderator of the voice channel.",
            args: ["newmod", true],
            minArgs: 0,
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {

            if (!this.testEnv(env)) return true;
        
            let meta = this.getVoiceChannelInfo(channelid);
            if (!meta) {
                ep.reply("There is no voice channel for this text channel.");
                return true;
            }

            let newmodname = args.newmod.join(" ");
            if (!newmodname) {
                ep.reply("Moderator: " + env.idToDisplayName(meta.mod));
                return true;
            }

            let textchannel = await this.denv.server.channels.fetch(channelid);

            if (this.ownerCheck() && !await this.be('Users').testPermissions(env.name, userid, channelid, this.ownershipPermissions(channelid, textchannel.parentId))) {
                ep.reply("You don't have permission to do that here.");
                return true;
            }

            let newmoduserid = env.displayNameToId(newmodname);
            if (!newmoduserid) {
                ep.reply("There is no such user.");
                return true;
            }

            await this.transferModeratorship(channelid, newmoduserid);
            ep.reply("Channel reassigned.");
        
            return true;
        });

        this.be('Commands').registerCommand(this, 'vc modperms', {
            description: "Read or set the list of permissions to give the moderator of a temporary voice channel.",
            details: [
                "Use - to unset.",
                "List of permissions: https://discord.com/developers/docs/topics/permissions"
            ],
            args: ["permissions", true],
            minArgs: 0,
            permissions: [permAdmin]
        }, (env, type, userid, channelid, command, args, handle, ep) => {
 
            if (!this.testEnv(env)) return true;
        
            if (!args.permissions.length) {
                if (!this._settings.modvoiceperms.length) {
                    ep.reply("Temporary voice channel moderators aren't set to receive any permissions.");
                } else {
                    ep.reply("Default permissions for temporary voice channel moderators: " + this._settings.modvoiceperms.join(", "));
                }
                return true;
            }
            
            if (args.permissions[0] == "-") {
                this._settings.modvoiceperms = [];
                this._settings.save();
                ep.reply("Temporary voice channel moderators will no longer receive any permissions.");
                return true;
            }
            
            let wrong = [];
            let right = [];
            for (let permission of args.permissions) {
                permission = permission.toUpperCase();
                if (PermissionsBitField.Flags[permission] == undefined) {
                    wrong.push(permission);
                } else {
                    right.push(permission);
                }
            }
            
            if (wrong.length) {
                ep.reply("The following permission(s) were not found: " + wrong.join(", "));
                return true;
            }
            
            this._settings.modvoiceperms = right;
            this._settings.save();
            ep.reply("The new permissions for temporary voice channel moderators were successfully set.");
            return true;
        });


        return true;
    }
        
    
    // # Module code below this line #

    testEnv(env) {
        return env.name == this.denv.name;
    }

    ownerCheck() {
        return this.param("permissions") !== true;
    }

    ownershipPermissions(channelid, parentid) {
        return this.param("permissions").map(template => template
                    .replaceAll(/%env%/g, this.denv.name)
                    .replaceAll(/%channelid%/g, channelid)
                    .replaceAll(/%parentid%/g, parentid || "noparent"));
    }

    getVoiceChannelInfo(textchanid) {
        return this._voices[textchanid];
    }

    getVoiceChannel(textchanid) {
        let meta = this.getVoiceChannelInfo(textchanid);
        if (!meta) return;
        return this.denv.server.channels.cache.get(meta.voice);
    }

    getTextChannel(voicechanid) {
        let textchanid = this._revindex[voicechanid];
        if (!textchanid) return;
        return this.denv.server.channels.cache.get(textchanid);
    }
    
    async createVoiceChannel(textchanid, userid) {
        let textchan = this.denv.server.channels.cache.get(textchanid);
        if (!textchan) return;

        let voicechan = await this.denv.server.channels.create({
            name: textchan.name,
            type: ChannelType.GuildVoice,
            parent: textchan.parent,
            permissionOverwrites: [
                {id: this.denv.client.realClient.user.id, allow: BOT_PERMS_IN_VOICE_CHAN, type: OverwriteType.Member},
                {id: userid, allow: this._settings.modvoiceperms, type: OverwriteType.Member}
            ],
            position: textchan.position + 1,
            reason: "Temporary voice channel."
        });

        this._voices[textchanid] = {voice: voicechan.id, mod: userid, pin: false};
        this._voices.save();
        this._revindex[voicechan.id] = textchanid;

        return voicechan;
    }

    async removeVoiceChannel(textchanid) {
        let voicechan = this.getVoiceChannel(textchanid);
        if (!voicechan) return;
        await voicechan.delete("Removing temporary voice channel.");
        return this.unregisterVoiceChannel(textchanid);
    }

    async removeVoiceChannelByVoiceId(voicechanid) {
        let textchanid = this._revindex[voicechanid];
        if (!textchanid) return;
        return this.removeVoiceChannel(textchanid);
    }

    unregisterVoiceChannel(textchanid) {
        let meta = this._voices[textchanid];
        if (!meta) return true;
        if (this._revindex[meta.voice]) {
            delete this._revindex[meta.voice];
        }
        delete this._voices[textchanid];
        this._voices.save();
        return true;
    }

    async transferModeratorship(textchanid, newmoduserid) {
        let meta = this.getVoiceChannelInfo(textchanid);
        if (!meta) return false;
        let voicechan = this.getVoiceChannel(textchanid);
        
        let oldmod = voicechan.permissionOverwrites.cache.get(meta.mod);
        if (oldmod) {
            await oldmod.delete("Transfer moderatorship to " + newmoduserid);
        }

        let permmap = {};
        for (let perm of this._settings.modvoiceperms) {
            permmap[perm] = true;
        }
        await voicechan.permissionOverwrites.edit(newmoduserid, permmap, {reason: "Transfer moderatorship from " + meta.mod});

        meta.mod = newmoduserid;
        this._voices.save();

        return true;
    }


}
