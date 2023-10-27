import Behavior from "../src/Behavior.js";

export default class BridgeSimple extends Behavior {

    get description() { return "Bridges a pair of single channels in any two single environments without any style or mention conversions"; }

    get params() { return [
        {n: 'envA', d: "Name of the environment A"},
        {n: 'envB', d: "Name of the environment B"},
        {n: 'chanA', d: "Name of a channel in the environment A"},
        {n: 'chanB', d: "Name of a channel in the environment B"},
        {n: 'tagEnvironment', d: "Prepend each message with the name of the source environment"},
        {n: 'tagChannel', d: "Prepend each message with the name of the source channel"},
        {n: 'oneWay', d: "Set to 'A' if only environment A can send messages, or 'B' if only B can send messages"}
    ]; }

    get defaults() { return {
        chanA: null,
        chanB: null,
        tagEnvironment: false,
        tagChannel: false,
        oneWay: null
    }; }

    get isMultiInstanceable() { return true; }

    constructor(name) {
        super('BridgeSimple', name);

    }


    get envA() {
        return this.env('envA');
    }
    
    get envB() {
        return this.env('envB');
    }
    

    initialize(opt) {
        if (!super.initialize(opt)) return false;
        
        //Register callbacks
        
        this.envA.on('message', this.onMessage, this);
        if (this.envA.name != this.envB.name) {
            this.envB.on('message', this.onMessage, this);
        }
        
        return true;
    }


    // # Module code below this line #


    //Event handler

    onMessage(env, type, message, authorid, channelid) {
        if (type != "action" && type != "regular") return;
        
        let targetenv = null;
        let targetchan = null;
        
        if (env.name == this.param('envA')) {
            if (!this.param('chanA') || channelid == this.param('chanA')) {
                if (this.param('oneWay') == 'B') return;
                targetenv = this.envB;
                targetchan = this.param('chanB');
            }        
        } 
        if (env.name == this.param('envB')) {
            if (!this.param('chanB') || channelid == this.param('chanB')) {
                if (this.param('oneWay') == 'A') return;
                targetenv = this.envA;
                targetchan = this.param('chanA');
             }
        }
        if (!targetenv) return;
        
        let finalmsg = '<' + env.idToDisplayName(authorid) + '> ' + targetenv.applyFormatting(env.normalizeFormatting(message));
        
        if (this.param('tagChannel')) finalmsg = '[' + env.channelIdToDisplayName(channelid) + '] ' + finalmsg;
        if (this.param('tagEnvironment')) finalmsg = '{' + env.name + '} ' + finalmsg;
        
        targetenv.msg(targetchan, finalmsg);
    }
    
    
}
