import Behavior from "../src/Behavior.js";

export default class StoatOpenDM extends Behavior {

    get description() { return "Adds a command, \"dm\", to request a DM from the bot in Stoat"; }

    get requiredEnvironments() { return {
        Stoat: 'Stoat'
    }; }

    get requiredBehaviors() { return {
        Commands: 'Commands'
    }; }

    constructor(name) {
        super('StoatOpenDM', name);
        
    }
    
    initialize(opt) {
        if (!super.initialize(opt)) return false;

      
        //Register callbacks
        
        this.be('Commands').registerCommand(this, 'dm', {
            description: "Request a DM from the bot.",
            types: ["regular"]
        }, async (env, type, userid, channelid, command, args, handle, ep) => {
        
            const member = this.env("Stoat").server.getMember(userid);
            ep.priv("Hi!");
            ep.ok();

            return true;
        });
      
        return true;
    };

}

