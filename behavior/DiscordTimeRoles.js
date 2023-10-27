import moment from 'moment';

import Behavior from '../src/Behavior.js';

export default class DiscordTimeRoles extends Behavior {

    get description() { return "A Time addon that sets Discord roles based on timezone offsets"; }

    get params() { return [
        {n: 'roles', d: "A map of {ROLEID: {MIN, MAX}, ...} where MIN and MAX are timezone offsets in minutes."},
        {n: 'strict', d: "If true, removes incorrect roles on startup."}
    ]; }

    get defaults() { return {
        strict: false
    }; }
    
    get requiredEnvironments() { return {
        Discord: 'Discord'
    }; }

    get requiredBehaviors() { return {
        Time: 'Time'
    }; }

    get denv() {
        return this.env('Discord');
    }

    constructor(name) {
        super('DiscordTimeRoles', name);

    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;


        //Register handlers

        this.denv.on("connected", async () => {

            for (let member of this.denv.server.members.cache.values()) {
                let utcOffset = await this.be("Time").getCurrentUtcOffsetByUserid(this.denv.name, member.id);
                if (utcOffset == null && !this.param("strict")) continue;
                
                //Modify assignments on startup
                
                this.addAndRemoveRoles(member, utcOffset, this.param("strict"));

            }

        });
        

        //Modify assignments on timezone change

        this.be("Time").registerTimezoneCallback((envname, userid, handle, tzinfo) => {
            if (envname != this.denv.name) return false;

            this.addAndRemoveRoles(this.denv.server.members.cache.get(userid), moment().tz(tzinfo.name).utcOffset(), true);

        });

        return true;
    }
        
    
    // # Module code below this line #

    addAndRemoveRoles(member, utcOffset, strict) {
        let addroles = [], removeroles = [];
        for (let roleid in this.param("roles")) {
            let roleconf = this.param("roles")[roleid];
            if (utcOffset == null || roleconf.max && utcOffset > roleconf.max || roleconf.min && utcOffset < roleconf.min) {
                if (member.roles.cache.get(roleid)) {
                    removeroles.push(roleid);
                }
            } else {
                if (!member.roles.cache.get(roleid)) {
                    addroles.push(roleid);
                }
            }
        }

        let doaddroles = Promise.resolve();
        if (addroles.length) {
            doaddroles = member.roles.add(addroles, "Adding role" + (addroles.length != 1 ? "s" : "") + " based on timezone rules.");
        }
        
        if (strict && removeroles.length) {
            //Circumventing discord.js bug
            doaddroles.then(() => member.roles.remove(removeroles, "Removing role" + (removeroles.length != 1 ? "s" : "") + " based on timezone rules."));
        }
    }


}
