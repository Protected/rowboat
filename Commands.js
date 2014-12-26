//TODO: Figure a dynamic way of restricting commands by channel access but only on specific channels where an admin enables it( and then implement ;-) )
//TODO: Bold [Random Event]
//TODO: Change relations to use a database.
//TODO: ^ for the slave game + full rewrite.

//List of Commands
var _ = require('underscore');
var gates = require('logic-gates');
var jf = require('jsonfile');
var TimerJob = require('timer-jobs');
var ElizaBot = require("elizabot");

var PA = null;
var commandList = [{
    command: "therapy",
    func: _therapyCmd,
    help: ">:D",
    dest: "any",
	permission: "z",
},{
    command: "hal",
    func: _halCmd,
    help: ">:D",
    dest: "any",
	permission: "z",
}, {
    command: "help",
    func: _helpCmd,
    help: "Provides contextual help about a command.",
    syntax: "+help <command_name>",
    dest: "any",
    minParams: 1
}, {
    command: "commands",
    func: _commandsCmd,
    dest: "source",
    help: "Lists all the available commands."
}, {
    command: "adduser",
    func: _adduserCmd,
    dest: "source",
    help: "Adds a user to the access list.",
    syntax: "+adduser <username> <vhost>",
    permission: "z",
    minParams: 2
}, {
    command: "pfact",
    func: _pfactCmd,
    dest: "any",
    help: "Shows the prime factorization of a given number.",
    syntax: "+pfact <number>",
	minParams: 1
}, {
    command: "eval",
    func: _evalCmd,
    dest: "any",
    help: "Runs JS code on the fly",
    syntax: "+eval",
    permission: "z"
}, {
    command: "deluser",
    func: _deluserCmd,
    dest: "source",
    help: "Removes a user from the access list.",
    syntax: "+deluser <username>",
    permission: "z",
    minParams: 1
}, {
    command: "addperm",
    func: _addpermCmd,
    dest: "source",
    help: "Grants a permission flag to a given user.",
    syntax: "+addperm <username> <flag>",
    permission: "z",
    minParams: 2
}, {
    command: "delperm",
    func: _delpermCmd,
    dest: "source",
    help: "Revokes a permission flag from a given user.",
    syntax: "+delperm <username> <flag>",
    permission: "z",
    minParams: 2
}, {
    command: "lsusers",
    func: _lsusersCmd,
    dest: "any",
    help: "Lists registered users or provides detailed information about a given user.",
    syntax: "+lsusers [username]",
    permission: "z"
}, {
    command: "whoami",
    func: _whoamiCmd,
    help: "Provides information about your registered user.",
    dest: "any"
}, {
    command: "minecraft",
    func: _mcCmd,
    dest: "any",
    help: "Provides information regarding the minecraft server."
}, {
    command: "quit",
    func: _quitCmd,
    dest: "any",
    help: "Forces the bot to quit.",
    permission: "z"
}, {
    command: "names",
    func: _namesCmd,
    dest: "source",
    help: "Lists the users in a channel.",
    syntax: "+names <#channel>",
    permission: "z",
    minParams: 1
}, {
    command: "raw",
    func: _rawCmd,
    dest: "source",
    help: "Executes a raw command.",
    permission: "z"
}, {
    command: "relation",
    func: _relationCmd,
    dest: "any",
    help: "Shows how two players are related.",
    syntax: "+relation <name1> <name2>",
    minParams: 2
}, {
    command: "addrel",
    func: _addrelCmd,
    dest: "any",
    help: "Adds a new relation to the list.",
    syntax: "+addrel {1} and {2} do things.",
	permission: "r",
    minParams: 3
}, {
    command: "gate",
    func: _gateCmd,
    dest: "any",
    help: "Executes logic operations.",
    syntax: "+gate <boolean> <and|or|nand|nor|xor|xnor|not> <boolean>",
    minParams: 3
}, {
    command: "bomb",
    func: _bombCmd,
    dest: "channel",
    help: "Plants a bomb on someone.",
    syntax: "+bomb <nick>",
    minParams: 1
}, {
    command: "defuse",
    func: _defuseCmd,
    dest: "channel",
    help: "Attempts to defuse the bomb.",
    syntax: "+defuse <wire>",
    minParams: 1
}, {
    command: "duel",
    func: _duelCmd,
    dest: "channel",
    help: "Starts a duel with a given player!",
    syntax: "+duel <username>",
    minParams: 1
}, {
    command: "cancelduel",
    func: _cancelDuelCmd,
    dest: "channel",
    help: "Cancels active duel."
}, {
    command: "atk",
    func: _atkCmd,
    dest: "channel",
    help: "Attacks when in a duel.",
    syntax: "+atk <object/verb/anything_weaponizable>",
    minParams: 1
}, {
    command: "addLanguage",
    func: _addLanguageCmd,
    dest: "any",
    help: "Adds a language to the list.",
	syntax: "+addLanguage <LanguageName>",
	permission: "l",
	minParams: 1
}, {
    command: "remLanguage",
    func: _remLanguageCmd,
    dest: "any",
    help: "Removes a Language from the list",
	syntax: "+remLanguage <LanguageName>",
	permission: "l",
	minParams: 1
}, {
    command: "addSpeaker",
    func: _addSpeakerCmd,
    dest: "any",
    help: "Associates a speaker to a language",
	syntax: "+addSpeaker <LanguageName> <Nick>",
	permission: "l",
	minParams: 2
}, {
    command: "languages",
    func: _languagesCmd,
    dest: "any",
    help: "Lists all languages",
}, {
    command: "speaks",
    func: _speaksCmd,
    dest: "any",
    help: "Queries who speaks which language.",
	syntax: "+speaks <language>",
	minParams: 1
}, {
    command: "slv",
    func: _slaveryCmd,
    dest: "any",
    help: "Has many functions to play the slave game.",
	syntax: "+slv <work|give|steal|buy|buyout|release|thrust|learn|stats> [<args>]",
	minParams: 1
}, {
    command: "cah",
    func: _cahCmd,
    dest: "any",
    help: "To play CaH",
	syntax: "+cah (under construction)"
}, {
    command: "cahjoin",
    func: _cahjoinCmd,
    dest: "source",
    help: "To enter a round of CaH.",
	syntax: "+cahjoin (under construction)"
}, {
    command: "cahplay",
    func: _cahplayCmd,
    dest: "source",
    help: "To play a card of CaH.",
	syntax: "+cahplay (under construction)",
	minParams: 1
}, {
    command: "cahvote",
    func: _cahvoteCmd,
    dest: "source",
    help: "To vote on a round of CaH",
	syntax: "+cahvote (under construction)"
}];
//Find Command
function getCommand(commandStr){
	return _.find(commandList, function(commandObj) { return commandObj.command == commandStr });
}
//Set Main Instance PA
function setMain(mains){
	PA = mains;
}
//Exports
exports.commandList = commandList;
exports.getCommand = getCommand;
exports.setMain = setMain;
exports.slaveTimer = new TimerJob({interval: 1000*60*15, immediate: false}, function(done) {
	addTick();
    done();
});
exports.slaveTimer.start();

function addTick() {
	var slaves =  jf.readFileSync('slaves.json');
	
	var rnd = 1;
	if ( randomIntInc(0,100) > 50 ){
	
		var randomSlave = slaves[randomIntInc(0,slaves.length-1)];
	
		switch(rnd){
			case 1: {
				PA.client.say("#game","[Random Event] Slave "+randomSlave.nick+" has lost some money in gambling.");
				randomSlave.money *= 0.98;
				break;
			}
		
		}
	}
	_.each(slaves, function( slave ) {
		slave.tired = false;
		if ( slave.mood > 0 ) {
			slave.mood *= 0.95;
		}
	});
	
	jf.writeFileSync('slaves.json',slaves);
	PA.client.say("#game","[SLV] New Tick!");
	console.log('new turn');
}

function _connCmd ( from, to, dest, message, messageObj){
	for (var property in PA.client.conn) {
		if (PA.client.conn.hasOwnProperty(property)) {
			console.log(property);
		}
	}
	
}

//Aux
function isUserInChannel(channel, nick){
	var c = _.find(Object.keys(PA.client.chans), function(c){
		return c == channel;
	});
	c = PA.client.chans[c];
	if ( !c ) {
		return false;
	} else {
		var users = Object.keys(c.users);
		var fn = _.find(users, function(u){ return u.toLowerCase() == nick.toLowerCase();});
		if ( fn ) return true;
		else return false;
	}
}
function randomIntInc (low, high) {
    return Math.floor(Math.random() * (high - low + 1) + low);
}

// Commands
//+hello
function _therapyCmd(from, to, dest, message){
	//PA.client.notice(from,"World!");
	if ( ! PA.therapist ) PA.therapist = {};
	if ( ! PA.therapist[from] ) {
		PA.therapist[from] = new ElizaBot();
		var reply = PA.therapist[from].getInitial();
		PA.client.say(dest,reply);
	} else {
		message.splice(0,1);
		var mess = message.join(" ");
		var reply = PA.therapist[from].transform(mess);
		PA.client.say(dest,reply);
		if ( PA.therapist[from].quit ) {
			delete PA.therapist[from];
		}
	}

}
function _halCmd(from, to, dest, message){

}
//+help
function _helpCmd(from, to, dest, message){
	var commandObj = getCommand(message[1]);
	if(!commandObj) { PA.client.say(dest,"Command not found!"); return }
	if(commandObj.help) PA.client.say(dest, commandObj.help);
	if(commandObj.syntax) PA.client.say(dest, commandObj.syntax);
	if(commandObj.permission) PA.client.say(dest,"Requires permission " + commandObj.permission + ".");
}
//+commands
function _commandsCmd(from, to, dest, message,messageObj){
	var str = "";
	_.each(commandList, function(commandObj){
		if( PA.checkForPermission(from,messageObj.host,commandObj.permission) ) 
			str += (commandObj.command + " ");
	});
	PA.client.say(from, str);
}
//+minecraft
function _mcCmd(from, to, dest, message){
	PA.client.say(from, "Server running on wyvernia.net (default port) with the modpack: FTB - DireWolf20 1.7.10 v1.0.1");
}

//+quit
function _quitCmd(from, to, dest, message){
	PA.client.disconnect("Freedom is liquid.");
}
//+raw
function _rawCmd(from, to, dest, message){
	message.splice(0,1);
	PA.client.send.apply(this,message);
}
function _evalCmd(from,to,dest,message,messageObj ){
	message.splice(0,1);
	var run = message.join(' ');
	try {
		eval(run);
	} catch ( e ) {
		PA.client.say(dest,""+e);
	}

}
//+relation
function _relationCmd( from, to, dest, message, messageObj){
	var name1 = message[1];
	var name2 = message[2];
	
	if ( name1 == name2 ) { PA.client.say(dest,"Names can't be equal."); return; }
	var sum = 0;
	for(var i=0;i<name1.length;i++){ 
		sum += name1.charCodeAt(i);
	}
	var vName1 = sum;
	for(var i=0;i<name2.length;i++){ 
		sum += name2.charCodeAt(i);
	}
	var vName2 = sum - vName1;
	
	if ( vName2 > vName1 ) {
		var aux = name1;
		name1 = name2;
		name2 = aux;
	}
	
	/*
	var list=[
		"{1} and {2} are friends!",
		"{1} and {2} are enemies.",
		"{1} and {2} sleep in the same bed."
	];*/
	
	var list = jf.readFileSync('relations.json');
	
	var choice = sum % list.length;
	var fin = list[choice].replace("{1}",name1).replace("{2}",name2);
	
	PA.client.say(dest, fin);
}

function _addrelCmd(from, to, dest, message, messageObj){
	message.splice(0,1);
	var relStr = message.join(' ');
	
	var relations = jf.readFileSync('relations.json');
	relations.push(relStr);
	jf.writeFileSync('relations.json',relations);

	PA.client.say(dest, "Relation added!");
}

//+gate
function _gateCmd(from, to, dest, message){
	var booleansA = [
		{
			str: "true",
			value: true
		},{
			str: "false",
			value: false
		}
	];
	var gatesA = [
		{
			str: "and",
			value: gates.and
		},{
			str: "or",
			value: gates.or
		},{
			str: "nor",
			value: gates.nor
		},{
			str: "xnor",
			value: gates.xnor
		},{
			str: "nand",
			value: gates.nand
		},{
			str: "xor",
			value: gates.xor
		},{
			str: "not",
			value: gates.not
		}
	
	];
	var p1 = _.find(booleansA, function(bo) { return bo.str.toLowerCase() == message[1].toLowerCase(); });
	var p2 = _.find(booleansA, function(bo) { return bo.str.toLowerCase() == message[3].toLowerCase(); });
	var gat = _.find(gatesA, function(ga) { return ga.str.toLowerCase() == message[2].toLowerCase(); });
	if ( !p1 || !p2 || !gat ) return;
	PA.client.say(dest, p1.str + " " + gat.str + " " + p2.str + " = " + gat.value(p1.value, p2.value));
	//PA.client.
}

function _bombCmd (from, to, dest, message, messageObj){
	if ( dest == from ) { PA.client.say("Can't bomb in PM."); return ; }
	var bombee = message[1];
	
	if ( bombee.toLowerCase() == "Praecantatio".toLowerCase() ) {
		PA.client.say(dest,"Can't bomb the bot. Dummass.");
		return;
	}
	if ( bombee.toLowerCase() == from.toLowerCase() ) {
    		PA.client.say(dest,"Feeling suicidal? Use a razor instead.");
    		return;
    }
    if ( !isUserInChannel(dest, bombee) ) {
    		PA.client.say(dest,"There is no one in the channel with that nick.");
    		return;
    }
	if ( PA.bombCD && PA.bombCD[from] && ( new Date().getTime() - PA.bombCD[from] < 1000*60*2) ) {
		PA.client.say(dest,"Better wait a bit before you do that again.");
		return;
	}
	
	
	if ( !PA.bomb ) {
		var wires = ["red","green","blue","yellow","black"];
		PA.bomb = {};
		if ( !PA.bombCD ) PA.bombCD = {};
		PA.bombCD[from] = new Date().getTime();
		PA.bomb.bombee = bombee;
		PA.bomb.event = setTimeout(_bombBlowEvent, 20000);
		PA.bomb.wire = wires[Math.floor(Math.random()*wires.length)];
		if ( message.length > 2 && message[2] == "-s" && PA.checkForPermission(from, messageObj.host, 'b')){
			PA.bomb.wire = 'death';
			PA.bomb.super = true;
		}
		PA.bomb.channel = dest;
		PA.client.say(dest,(PA.bomb.super?"Super-":"")+"Bomb has been planted on "+bombee+".");
        PA.client.say(dest,"Try to defuse it with +defuse <red|green|blue|yellow|black>.");
	}
	
	function _bombBlowEvent(){
		if ( PA.bomb ) {
			PA.client.say(dest,"Bomb has exploded and "+PA.bomb.bombee+" went Kaboom!");
			PA.client.send("KICK",PA.bomb.channel,PA.bomb.bombee,"Badaboom!");
			delete PA.bomb;
		}
	}
}
function _defuseCmd (from, to, dest, message, messageObj){
	if ( PA.bomb && message[1] == "-f" && PA.checkForPermission(from, messageObj.host, 'b') ){
		PA.client.say(dest,"Bomb removed from existence.");
		clearTimeout(PA.bomb.event);
        delete PA.bomb;
	}
	if ( PA.bomb && from == PA.bomb.bombee) {
		if ( message[1].toLowerCase() == PA.bomb.wire.toLowerCase() ){
			PA.client.say(dest,"Bomb defused.");
		} else {
			PA.client.say(dest,"Wrong wire! Bomb exploded. :D");
			PA.client.send("KICK",PA.bomb.channel,PA.bomb.bombee,"Badaboom!");
		}
		clearTimeout(PA.bomb.event);
		delete PA.bomb;
	}
}

function _namesCmd (from, to, dest, message, messageObj){
	var c = _.find(Object.keys(PA.client.chans), function(c){
		return c == message[1];
	});

	c = PA.client.chans[c];

	if ( !c ) {
		PA.client.notice(from,"I'm not in that channel.");
	} else {
		var str = "";

		for ( var user in c.users ){
			str += (c.users[user]+user+", ");
		}

		PA.client.say(from,str);
	}

}

function _adduserCmd ( from, to, dest, message, messageObj ){
	var nick = message[1];
	var vhost = message[2];
	var perm;
	PA.mdb.User.count({},function(err,count){
		if ( err ) return;
		perm = count==0?"z":"";
		
		PA.mdb.User.count({'nick':nick}, function(err,data){
			if ( err ) return;
			if ( data ){
				PA.client.say(dest,"User with that nick already exists.");
				return;
			}
			var newUser = new PA.mdb.User({
				'nick': nick,
				'host': vhost,
				'permissions': perm
			});

			newUser.save(function(err,nAff) {
				if ( err ) return;
				PA.client.say(dest,"User "+newUser.nick+" created successfuly.");
				PA.loadUsers();
			});
			
		});
	});
}

function _deluserCmd ( from, to, dest, message, messageObj ){
	var usrs = PA.users;
	var nick = message[1];
	if ( !usrs ) return;
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }
	//PA.users = _.without(PA.users, _.findWhere(PA.users, {'nick': nick}));
	
	/*
	var mUser = PA.mdb.User.find({
		nick: nick
	});
	*/
	
	usr.remove(function(err,data){
		PA.client.say(dest,"Removed user "+nick+".");
		PA.loadUsers();
	});
}

function _addpermCmd ( from, to, dest, message, messageObj ){
	var usrs = PA.users;
	var nick = message[1];
	var perms = message[2];
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }

	for ( var i = 0; i < perms.length; i++ ){
		var perm = perms.charAt(i);
		if ( usr.permissions.indexOf(perm) < 0 ){
			usr.permissions += perm;
		}
	}

	usr.save(function(err,nAff) {
		PA.client.say(dest, "Permission(s) added." );
		PA.loadUsers();
	});
		
	
	
}

function _delpermCmd ( from, to, dest, message, messageObj ){
	var usrs = PA.users;
	var nick = message[1];
	var perms = message[2];
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }

	for ( var i = 0; i < perms.length; i++ ){
		var perm = perms.charAt(i);
		usr.permissions = usr.permissions.replace(perm,'');
	}
	
	usr.save(function(err,nAff) {
		PA.client.say(dest, "Permission(s) removed." );
		PA.loadUsers();
	});
}

function _lsusersCmd ( from, to, dest, message, messageObj ){
	var usrs = PA.users;
	if ( !usrs ) return;

	if ( message.length == 2){
		var nick = message[1];
        var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
		if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }
		PA.client.say(dest,"N:"+usr.nick+" H:"+usr.host+" F:"+usr.permissions);
		return;
	}

	var str = "";
	for( var i=0; i<usrs.length; i++){
		str += (usrs[i].nick + ", ");
	}
	PA.client.say(dest,str);
}

function _whoamiCmd( from, to, dest, message, messageObj ){
	var usr = _.find(PA.users, function(user){ return user.nick.toLowerCase() == from.toLowerCase() ;});
	if ( !usr ) { PA.client.notice(from, "You are not in the list." ); return; }
	PA.client.notice(from,"N:"+usr.nick+" H:"+usr.host+" F:"+usr.permissions);
}

function _duelCmd( from, to, dest, message, messageObj ){
	var target = message[1];
	if ( !isUserInChannel(dest, target) ) {
		PA.client.say(dest,"There is no one in the channel with that nick.");
		return;
	}
	if ( PA.duel ){
		PA.client.notice(from,"Duel already in progress.");
		return;
	} else {
		PA.duel = {};
		PA.duel.duelists = [{ 'nick': from ,  'hp': 1000},
							{ 'nick': target, 'hp': 1000}];
		PA.duel.turn = 0;

		PA.client.say(dest,"Duel starting between "+from+" and "+target+".");
		PA.client.say(dest, PA.duel.duelists[0].nick+"("+PA.duel.duelists[0].hp+") ~ ("+PA.duel.duelists[1].hp+")"+PA.duel.duelists[1].nick);
	}

}

function _atkCmd( from, to, dest, message, messageObj ){
	var thing = message[1];

	if ( !PA.duel ){
		PA.client.notice(from,"No duel in progress. Check the help for duel.");
		return;
	} else {

		var turnee = PA.duel.duelists[PA.duel.turn];
		var turned = PA.duel.duelists[(PA.duel.turn+1)%2];
		if ( !(turnee.nick.toLowerCase() == from.toLowerCase()) ){
			PA.client.notice(from,"It's not your turn!");
			return;
		}
		var damage = 0;
		var crit = 0;
		var lifesteal = 0;
		var stun = 0;
		var critDmg = 2;
		var chaos = 0;
		var vow = new RegExp("[aeiou]","ig");
		var con = new RegExp("[bcdfghklmnprstvwxy]","ig");
		var sup = new RegExp("[!#$%&?.]","ig");
		var spe = new RegExp("[jzq]","ig");


		for(var i = 0; i < thing.length; i++) {
			var ch = thing.charAt(i);
			if ( vow.test(ch) ){
				damage += 10;
				crit = crit+((100-crit)*0.1);
				chaos += 2;
			} else if ( con.test(ch) ){
				damage += 20;
				lifesteal = lifesteal + ((100-lifesteal)*0.05);
				chaos += 2;
			} else if ( sup.test(ch) ){
				damage += 20;
				stun = stun + ((100-stun)*0.05);
				chaos += 10;
			} else if ( spe.test(ch) ){
				damage += 50;
				critDmg += 1;
				chaos += 20;
			}
		}

		//PA.client.say(dest,"DEBUG:"+damage+":"+crit+":"+lifesteal+":"+stun+":"+critDmg+":"+chaos);

		if ( randomIntInc(0,100) <= chaos ){
			turnee.hp -= damage;
			PA.client.say(dest,"The attack fiddled and you hurt yourself!");
			PA.duel.turn = (PA.duel.turn+1)%2;
		} else {
			var critted = false;
			var stunned = false;
			var lifestolen = 0;
			var trueDamage;
			if ( randomIntInc(0,100) <= crit ){
				critted = true;
			}
			if ( randomIntInc(0,100) <= stun ){
				stunned = true;
			}
			trueDamage = critted?damage*critDmg:damage;
			lifestolen = trueDamage * (lifesteal/100);

			turnee.hp += lifestolen;
			turned.hp -= trueDamage;

			var str = "Dealt "+trueDamage+" damage with "+(critted?("a "+critDmg+"x crit "):"no crit ") + (stunned?(", stunned "):"") + "and stole "+lifestolen+" hp.";
			PA.client.say(dest,str);

			if ( !stunned ){
				PA.duel.turn = (PA.duel.turn+1)%2;
			}

		}
		if ( turnee.hp <= 0 ) {
			PA.client.say(dest,turned.nick+" won the duel!");
			delete PA.duel;
		} else if (turned.hp <= 0 ) {
			PA.client.say(dest, turnee.nick+" won the duel!");
			delete PA.duel;
		} else {
			PA.client.say(dest, PA.duel.duelists[0].nick+"("+PA.duel.duelists[0].hp+") ~ ("+PA.duel.duelists[1].hp+")"+PA.duel.duelists[1].nick);
		}
	}

}

function _cancelDuelCmd( from, to, dest, message, messageObj ){
	if ( PA.duel ) {
		delete PA.duel;
		PA.client.notice(from,"Duel cancelled.");
	}
}


function _addLanguageCmd(from, to, dest, message,messageObj){
	var languages = jf.readFileSync('languages.json');
	
	if ( !languages[message[1]] ) {	
		languages[message[1]] = [];
		jf.writeFileSync('languages.json',languages);
		PA.client.say(dest, "Language added!");
	} else {
		PA.client.say(dest, "Language already exists.");
	}
}
function _remLanguageCmd(from, to, dest, message,messageObj){
	var languages = jf.readFileSync('languages.json');
	
	if ( languages[message[1]] ) {	
		delete languages[message[1]];
		jf.writeFileSync('languages.json',languages);
		PA.client.say(dest, "Language removed!");
	} else {
		PA.client.say(dest, "Language doesn't exist.");
	}
}
function _addSpeakerCmd(from, to, dest, message,messageObj){
	var languages = jf.readFileSync('languages.json');
	
	if ( languages[message[1]] ) {	
		languages[message[1]].push(message[2]);
		jf.writeFileSync('languages.json',languages);
		PA.client.say(dest, "Speaker added!");
	} else {
		PA.client.say(dest, "Language doesn't exist.");
	}
}
function _speaksCmd(from, to, dest, message,messageObj){
	var languages = jf.readFileSync('languages.json');
	
	if ( languages[message[1]] ) {	
		if ( languages[message[1]].length == 0 ) {
			PA.client.say(dest,"No speakers of that language.");
			return;
		}
		var str = "";
		for( var i=0; i<languages[message[1]].length; i++){
			str += (languages[message[1]][i] + ", ");
		}
		PA.client.say(dest,str);
	} else {
		PA.client.say(dest, "Language doesn't exist.");
	}
}

function _languagesCmd(from,to,dest,message,messageObj ){
	var languages = jf.readFileSync('languages.json');
	
	if ( languages ) {	
		var str = "";
		for(var language in languages) {
			str += (language+", ");
		}
		PA.client.say(dest,str);
	} else {
		PA.client.say(dest, "Something terrible happened.");
	}
	
}

function _slaveryCmd(from,to,dest,message,messageObj ){
	//var slavesMainObj = jf.readFileSync('slaves.json');

	var slaves =  jf.readFileSync('slaves.json');//slaves.slaves;
	var slavesMainObj = slaves;
	
	var playerObj = _.find(slaves, function(slv) {return slv.nick.toLowerCase() == from.toLowerCase();} );
	if ( ! playerObj ) {
		playerObj = {};
		slaves.push(playerObj);
		playerObj.nick = from;
		playerObj.money = 200;
		playerObj.alignment = 0;
		playerObj.mood = 0;
		playerObj.tired = false;
		playerObj.slaves = [];
		//playerObj.master = "";
		playerObj.fuk = {};
		playerObj.fuk.kissing = 0;
		playerObj.fuk.smooth = 0;
		playerObj.fuk.wooing = 0;
		playerObj.fuk.hard = 0;
		playerObj.logs = [];
		PA.client.say(dest, "Welcome to the slave game, "+from+". You are now part of something big! >:D");
		jf.writeFileSync('slaves.json',slavesMainObj);
	}
	
	switch (message[1]) {
		case 'work': {
			if ( playerObj.tired ) {
				PA.client.say(dest,"You're currently tired... need to wait for the next tick.");
				break;
			}
	
			var value = randomIntInc(50,200);
			var mult = 1;
			mult += ( 0.25 * Math.floor(playerObj.mood/50) );
			value *= mult;
			
			giveMoney(playerObj,value,0);
			playerObj.tired = true;
			jf.writeFileSync('slaves.json',slavesMainObj);
			
			var list = [
				 "{1} spent some time working at the local sex shop and made {2}€"
				,"{1} participated in a porno and got {2}€"
				,"{1} spent time building a statue in honor of Hel and got {2}€"
				,"{1} went to the streets and performed for the public. Ended up making {2}€"
				,"{1} went to a nearby park and scammed people for {2}€"
				,"{1} performed a strip-tease at the strip club and earnt {2}€"
				
			];
	
			var choice = randomIntInc(0, list.length-1);
			var fin = list[choice].replace("{1}",playerObj.nick).replace("{2}",value);
			PA.client.say(dest,fin);
			//PA.client.say(dest,playerObj.nick + " spent some time working at a local naughty store and made: "+value+"€.");
			
			break;
		}
		case 'steal': {
			break;
		}
		case 'give': {
			if ( message.length > 2 ) {
				
				if ( ! playerObj.master ) {
					PA.client.say(dest,"You don't have a master to give money to.");
					return;
				}
			
				var slaveName = playerObj.master;
				var slaveeObj = _.find(slaves, function(slv) {return slv.nick.toLowerCase() == slaveName.toLowerCase();} );
				if ( !slaveeObj ) {
					PA.client.say(dest,"No slave found with that nick.");
					return;
				}
				var money = message[2];
				money = parseInt(money);
				if ( isNaN(money) ) {
					PA.client.say(dest,"Bad value.");
					return;
				}
				
				if ( money < 1 || money > playerObj.money ) {
					PA.client.say(dest,"Bad number.");
					return;
				}
				
				playerObj.money -= money;
				slaveeObj.money += money;
				playerObj.mood  += money*0.5;
				
				
				PA.client.say(dest,"Slave "+playerObj.nick+" gave money to his master/mistress "+slaveeObj.nick+" and gained something in return.");
				jf.writeFileSync('slaves.json',slavesMainObj);
				
			} else {
				PA.client.say(dest,"Bad syntax... seek some +help :P");
			}
			
			break;
		}
		case 'thrust': {
			break;
		}
		case 'buy': {
			if ( message.length > 2 ) {
				var slaveName = message[2];
				var slaveeObj = _.find(slaves, function(slv) {return slv.nick.toLowerCase() == slaveName.toLowerCase();} );
				if ( !slaveeObj ) {
					PA.client.say(dest,"No slave found with that nick.");
					return;
				}
				if ( slaveeObj.master ) {
					PA.client.say(dest,"That person already has a master.");
					return;
				}
				if ( slaveeObj.nick == playerObj.nick ) {
					PA.client.say(dest,"Can't buy yourself.");
					return;
				}
				if ( playerObj.tired ) {
					PA.client.say(dest,"You are tired and can't buy a slave at this moment.");
					return;
				}
				
				
				
				
				if ( playerObj.money > slaveeObj.money ) {
					playerObj.money -= slaveeObj.money;
					playerObj.tired = true;
					slaveeObj.master = playerObj.nick;
					slaveeObj.boughtFor = slaveeObj.money;
					slaveeObj.boughtWhen = new Date().getTime();
					if ( ! playerObj.slaves ) playerObj.slaves = [];
					playerObj.slaves.push(slaveeObj.nick);
					
					PA.client.say(dest,"Slave "+slaveeObj.nick+" now belongs to "+playerObj.nick+".");
					logWrite(playerObj, "Bought "+slaveeObj.nick+" for "+slaveeObj.money+"€.");
					jf.writeFileSync('slaves.json',slavesMainObj);
					
				} else {
					PA.client.say(dest,"You don't have enough money to buy "+slaveeObj.nick+".");
				}
			}
			break;
		}
		case 'buyout': {
			
			if ( !playerObj.master ) {
				PA.client.say(dest,"You don't have a master.");
				return;
			}
			
			if ( !playerObj.boughtFor ) playerObj.boughtFor = 5000;
			if ( !playerObj.boughtWhen) playerObj.boughtWhen = new Date().getTime();
			
			var moneyToSpend = playerObj.boughtFor;
			var tax = Math.floor(((new Date().getTime()) - playerObj.boughtWhen)/1000/60/60/24/7)*5;
			moneyToSpend = moneyToSpend + moneyToSpend*(tax/100);
			
			if ( playerObj.tired ) {
				PA.client.say(dest,"You are tired and can't release yourself at this moment.");
				return;
			}
			
			if ( playerObj.money >= moneyToSpend ) {

				playerObj.money -= moneyToSpend;
				playerObj.tired = true;
				delete playerObj.master;
				delete playerObj.boughtFor;
				delete playerObj.boughtWhen;
				
				PA.client.say(dest,"Slave "+playerObj.nick+" freed themself for "+moneyToSpend+"€!");
				//logWrite(sObj, "Freed yourself.");
				jf.writeFileSync('slaves.json',slavesMainObj);
				
			} else {
				PA.client.say(dest,"You don't have enough money to release yourself. You need: "+moneyToSpend+"€");
			}
			break;
		}
		case 'release': {
			break;
		}
		case 'learn': {
			break;
		}
		case 'tick': {
			if ( PA.checkForPermission(from,messageObj.host,"z") ){
				addTick();
			}
			break;
		}
		case 'stats': {
			var targObj;
			if ( message.length > 2 && message[2].length > 0 ) {
				var name = message[2];
				var slaveeObj = _.find(slaves, function(slv) {return slv.nick.toLowerCase() == name.toLowerCase();} );
				if ( !slaveeObj ) {
					PA.client.say(dest,"No slave found with that nick.");
					return;
				}
				targObj = slaveeObj;
			} else {
				targObj = playerObj;
			}
			PA.client.say(dest,targObj.nick+"|| €:"+Math.round(targObj.money)+" Alignment:"+Math.round(targObj.alignment)+" Mood:"+Math.round(targObj.mood)+" Tired:"+targObj.tired+" Master:" +(targObj.master?targObj.master:"N/A"));
			break;
		}
		default: {
			PA.client.say(dest,"404 command not found~ // Tried +help?");
		}
		
		
		
		//***** AUX
		function giveMoney(sObj, value, depth){
			if ( depth > 2 ) return;
			if ( sObj.master ) {
				var split = value * 0.2;
				value -= split;
				masterObj = _.find(slaves, function(slv) {return slv.nick.toLowerCase() == sObj.master.toLowerCase();} );
				if ( masterObj ) { giveMoney(masterObj,split,depth+1); }
			} else {
				
			}
			sObj.money += value;
			logWrite(sObj, "Received "+value+"€ for working.");
		}
		function logWrite( sObj, log ){
			sObj.logs.push(log);
			if ( sObj.logs.length > 10 ) {
				sObj.logs.splice(0,1);
			}
		}
		//***** EO
	}
}

function _cahCmd(from,to,dest,message,messageObj ){
	
	var blackCards = jf.readFileSync('pick1.json');
	
	if ( !PA.cah ) PA.cah = {};
	
	if ( PA.cah && PA.cah.game ){
		PA.client.say(dest,"Game already going.");
		return;
	} else {
		if (!PA.cah.game) PA.cah.game = {};
		
		PA.cah.game.askee = from;
		PA.cah.game.chan = to;
		
		var bKeys = Object.keys(blackCards);
		var r = randomIntInc(0,bKeys.length-1);
		
		var card = blackCards[bKeys[r]];
		card.text = card.text.replace("_","_____");
		PA.cah.game.card = card;
		PA.cah.game.players = [];
		PA.cah.game.phase = 0;
		PA.cah.game.playEvent = setTimeout(_cahPlayEvent, 60000);
		
		PA.client.say(dest,"A new round of CaH has started! PM me with +cahjoin to enter the round!!");
		PA.client.say(dest,card.text);
		
	}
	
	function _cahPlayEvent ( ) {
		
		PA.cah.game.phase = 1;
		var chosenCards = [];
		
		for (var i = 0 ; i < PA.cah.game.players.length; i++ ) {
			var player = PA.cah.game.players[i];
			if ( player.chosenCard )
				chosenCards.push({nick: player.nick, card: player.chosenCard, votes: 0});
		}
		PA.cah.game.chosenCards = chosenCards;
		
		for (var i = 0 ; i < PA.cah.game.players.length; i++ ) {
			var player = PA.cah.game.players[i];
			PA.client.say(player.nick,"Time to vote. Use +cahvote <number>");
			for(var j=0; j<chosenCards.length; j++) {
				//if (chosenCards[j].nick != player.nick)
					PA.client.say(player.nick,(j+1)+": "+chosenCards[j].card.text);
			}
		}
		
		PA.cah.game.voteEvent = setTimeout(_cahVoteEvent, 60000);
	}
	function _cahVoteEvent ( ) {
		PA.cah.game.phase = 2;
		var chosenCards = PA.cah.game.chosenCards;
		
		var votedCards = _.sortBy(chosenCards, function(card){ return card.votes*-1; });
		
		PA.client.say(PA.cah.game.chan,"Black card was: "+PA.cah.game.card.text);
		PA.client.say(PA.cah.game.chan,"Results by votes: ");
		/*
		var max = 0;
		for (var i = 0 ; i < votedCards.length; i++ ) {
			var vCard = votedCards[i];
			if ( max <= vCard.votes ) {
				max = vCard.votes;
			}
		}
		*/
		for (var i = 0 ; i < votedCards.length; i++ ) {
			var vCard = votedCards[i];
			if ( vCard.votes > 0 ) {
				PA.client.say(PA.cah.game.chan,vCard.votes+" votes by "+vCard.nick+":"+vCard.card.text);
			}
		}
		
		delete PA.cah.game;
	}
}

function _cahjoinCmd(from,to,dest,message,messageObj ){
	if ( PA.cah && PA.cah.game ){
		var finder = _.find(PA.cah.game.players, function(player){ return player.nick.toLowerCase() == from.toLowerCase(); });
		if ( PA.cah.game.phase != 0 ) {
			PA.client.say(dest,"This is not joining phase.");
			return;
		}
		if ( finder ) {
			PA.client.say(dest,"You already joined.");
			return;		
		} else {
			var playerObj = {};
			playerObj.nick = from;
			playerObj.cards = [];
			var whiteCards = jf.readFileSync('answers.json');
			var wKeys = Object.keys(whiteCards);
			var passed = [];
			for(var i=0; i<5; ){
				var r = randomIntInc(0,wKeys.length-1);
				if ( passed.indexOf(r) == -1 ){
					playerObj.cards.push(whiteCards[wKeys[r]]);
					i++;
				}
			}
			PA.cah.game.players.push(playerObj);
			PA.client.say(dest,"Type: +cahplay <card number> to play. The black card is: "+PA.cah.game.card.text);
			for(var i=0; i<playerObj.cards.length; i++){
				PA.client.say(dest,(i+1)+": "+playerObj.cards[i].text);
			}
		}

	} else {
		PA.client.say(dest,"There is no game going right now.");
	}
}

function _cahplayCmd(from,to,dest,message,messageObj ){
	if ( PA.cah && PA.cah.game ){
		var finder = _.find(PA.cah.game.players, function(player){ return player.nick.toLowerCase() == from.toLowerCase(); });
		var choice = parseInt(message[1]);
		if ( isNaN(choice) ) {
			PA.client.say(dest,"Bad value...");
			return;
		}
		if ( PA.cah.game.phase != 0 ) {
			PA.client.say(dest,"This is not playing phase.");
			return;
		}
		if ( !finder ) {
			PA.client.say(dest,"You haven't joined yet, try +cahjoin");
			return;		
		} else {
			if ( choice > 0 && choice <= finder.cards.length ) {
				finder.chosenCard = finder.cards[--choice];
				PA.client.say(dest,"Wait for the voting round. You've chosen "+(++choice)+": "+finder.chosenCard.text);
			} else {
				PA.client.say(dest,"Bad value...");
				return;
			}
		}

	} else {
		PA.client.say(dest,"There is no game going right now.");
	}
}

function _cahvoteCmd(from,to,dest,message,messageObj ){
	if ( PA.cah && PA.cah.game ){
		var finder = _.find(PA.cah.game.players, function(player){ return player.nick.toLowerCase() == from.toLowerCase(); });
		var choice = parseInt(message[1]);
		if ( isNaN(choice) ) {
			PA.client.say(dest,"Bad value...");
			return;
		}
		if ( PA.cah.game.phase != 1 ) {
			PA.client.say(dest,"This is not voting phase.");
			return;
		}
		if ( !finder ) {
			PA.client.say(dest,"You haven't joined this round. :(");
			return;		
		} else {
			if ( finder.hasVoted ){
				PA.client.say(dest,"You have already voted.");	
				return;
			}
			var chosenCards = PA.cah.game.chosenCards;

			if ( choice > 0 && choice <= chosenCards.length ) {
				var card = chosenCards[--choice];
				card.votes += 1;
				finder.hasVoted = true;
				PA.client.say(dest,"You've voted for "+(++choice)+": "+card.card.text);
			} else {
				PA.client.say(dest,"Bad value...");
				return;
			}
		}

	} else {
		PA.client.say(dest,"There is no game going right now.");
	}
}


function _pfactCmd(from,to,dest,message,messageObj ){
	
	function factor(n) {
		 if (isNaN(n) || !isFinite(n) || n%1!=0 || n==0) return ''+n;
		 if (n<0) return '-'+factor(-n);
		 var minFactor = leastFactor(n);
		 if (n==minFactor) return ''+n;
		 return minFactor+'*'+factor(n/minFactor);
	}

		// find the least factor in n by trial division
	function leastFactor(n) {
		 if (isNaN(n) || !isFinite(n)) return NaN;  
		 if (n==0) return 0;  
		 if (n%1 || n*n<2) return 1;
		 if (n%2==0) return 2;  
		 if (n%3==0) return 3;  
		 if (n%5==0) return 5;  
		 var m = Math.sqrt(n);
		 for (var i=7;i<=m;i+=30) {
		  if (n%i==0)      return i;
		  if (n%(i+4)==0)  return i+4;
		  if (n%(i+6)==0)  return i+6;
		  if (n%(i+10)==0) return i+10;
		  if (n%(i+12)==0) return i+12;
		  if (n%(i+16)==0) return i+16;
		  if (n%(i+22)==0) return i+22;
		  if (n%(i+24)==0) return i+24;
		 }
		 return n;
	}
	
	var str = factor(message[1]);
	
	PA.client.say(dest,"Prime factorization of "+message[1]+": "+str);
}