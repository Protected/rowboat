//TODO: Destination Type as a parameter in the commandList Object
//TODO: Duel
//TODO: Figure a dynamic way of restricting commands by channel access but only on specific channels where an admin enables it( and then implement ;-) )

//List of Commands
var _ = require('underscore');
var gates = require('logic-gates');
var jf = require('jsonfile');

var PA = null;
var commandList = [
	{ 
		command: "hello", 
		func: _helloCmd,
		help: "Displays an Hello world."
	},{ 
		command: "help", 
		func: _helpCmd,
		help: "Provides contextual help about a command.",
		syntax: "+help <command_name>",
		minParams: 1
	},{ 
		command: "commands", 
		func: _commandsCmd,
		help: "Lists all the available commands."
	},{
		command: "adduser",
		func: _adduserCmd,
		help: "Adds a user to the access list.",
		syntax: "+adduser <username> <vhost>",
		permission: "z",
		minParams: 2
	},{
		command: "deluser",
		func: _deluserCmd,
		help: "Removes a user from the access list.",
		syntax: "+deluser <username>",
		permission: "z",
		minParams: 1
	},{
		command: "addperm",
		func: _addpermCmd,
		help: "Grants a permission flag to a given user.",
		syntax: "+addperm <username> <flag>",
		permission: "z",
		minParams: 2
	},{
		command: "delperm",
		func: _delpermCmd,
		help: "Revokes a permission flag from a given user.",
		syntax: "+delperm <username> <flag>",
		permission: "z",
		minParams: 2
	},{
		command: "lsusers",
		func: _lsusersCmd,
		help: "Lists registered users or provides detailed information about a given user.",
		syntax: "+lsusers [username]",
		permission: "z"
	},{
		command: "whoami",
		func: _whoamiCmd,
		help: "Provides information about your registered user."
	},{
		command: "minecraft",
		func: _mcCmd,
		help: "Provides information regarding the minecraft server."
	},{
		command: "quit", 
		func: _quitCmd,
		help: "Forces the bot to quit.",
		permission: "z"
	},{
		command: "names",
		func: _namesCmd,
		help: "Lists the users in a channel.",
		syntax: "+names <#channel>",
		permission: "z",
		minParams: 1
    },{
		command: "raw", 
		func: _rawCmd,
		help: "Executes a raw command.",
		permission: "z"
	},{ 
		command: "relation", 
		func: _relationCmd,
		help: "Shows how two players are related.",
		syntax: "+relation <name1> <name2>",
		minParams: 2
	},{ 
		command: "gate", 
		func: _gateCmd,
		help: "Executes logic operations.",
		syntax: "+gate <boolean> <and|or|nand|nor|xor|xnor|not> <boolean>",
		minParams: 3
	},{ 
		command: "bomb", 
		func: _bombCmd,
		help: "Plants a bomb on someone.",
		syntax: "+bomb <nick>",
		minParams: 1
	},{ 
		command: "defuse",
		func: _defuseCmd,
		help: "Attempts to defuse the bomb.",
		syntax: "+defuse <wire>",
		minParams: 1
	}

];
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

// Commands
//+hello
function _helloCmd(from, to, message){
	PA.client.say(from,"World!");
}
//+help
function _helpCmd(from, to, message){
	var commandObj = getCommand(message[1]);
	if(!commandObj) { PA.client.say(from,"Command not found!"); return }
	if(commandObj.help) PA.client.say(from, commandObj.help);
	if(commandObj.syntax) PA.client.say(from, commandObj.syntax);
	if(commandObj.permission) PA.client.say(from,"Requires permission " + commandObj.permission + ".");
}
//+commands
function _commandsCmd(from, to, message,messageObj){
	var str = "";
	_.each(commandList, function(commandObj){
		if( PA.checkForPermission(from,messageObj.host,commandObj.permission) ) 
			str += (commandObj.command + " ");
	});
	PA.client.say(from, str);
}
//+minecraft
function _mcCmd(from, to, message){
	PA.client.say(from, "Server running on wyvernia.net (default port) with the modpack: FTB - DireWolf20 1.7.10 v1.0.1");
}

//+quit
function _quitCmd(from, to, message){
	PA.client.disconnect("Freedom is liquid.");
}
//+raw
function _rawCmd(from, to, message){
	message.splice(0,1);
	PA.client.send.apply(this,message);
}
//+relation
function _relationCmd( from, to, message, messageObj){
	var name1 = message[1];
	var name2 = message[2];
	var dest = to.charAt(0)=='#'?to:from;
	
	if ( name1 == name2 ) { PA.client.say(dest,"Names can't be equal."); return; }
	var sum = 0;
	for(var i=0;i<name1.length;i++){ 
		sum += name1.charCodeAt(i);
	}
	for(var i=0;i<name2.length;i++){ 
		sum += name2.charCodeAt(i);
	}
	
	var list=[
		"{1} and {2} are friends!",
		"{1} and {2} are enemies.",
		"{1} and {2} sleep in the same bed."
	];
	
	var choice = sum % list.length;
	var fin = list[choice].replace("{1}",name1).replace("{2}",name2);
	
	PA.client.say(dest, fin);
}

//+gate
function _gateCmd(from, to, message){
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
	var dest = to.charAt(0)=='#'?to:from;
	var p1 = _.find(booleansA, function(bo) { return bo.str.toLowerCase() == message[1].toLowerCase(); });
	var p2 = _.find(booleansA, function(bo) { return bo.str.toLowerCase() == message[3].toLowerCase(); });
	var gat = _.find(gatesA, function(ga) { return ga.str.toLowerCase() == message[2].toLowerCase(); });
	if ( !p1 || !p2 || !gat ) return;
	PA.client.say(dest, p1.str + " " + gat.str + " " + p2.str + " = " + gat.value(p1.value, p2.value));
	//PA.client.
}

function _bombCmd (from, to, message, messageObj){
	var dest = to.charAt(0)=='#'?to:from;
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
	
	if ( !PA.bomb ) {
		var wires = ["red","green","blue","yellow","black"];
		PA.bomb = {};
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
function _defuseCmd (from, to, message, messageObj){
	var dest = to.charAt(0)=='#'?to:from;
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

function _namesCmd (from, to, message, messageObj){
	var c = _.find(Object.keys(PA.client.chans), function(c){
		return c == message[1];
	});

	c = PA.client.chans[c];

	if ( !c ) {
		PA.client.say(from,"I'm not in that channel.");
	} else {
		var str = "";

		for ( var user in c.users ){
			str += (c.users[user]+user+", ");
		}

		PA.client.say(from,str);
	}

}

function _adduserCmd ( from, to, message, messageObj ){
	var dest = to.charAt(0)=='#'?to:from;
	var usrs = PA.users;
	var nick = message[1];
	var vhost = message[2];
	if ( !usrs ) return;
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( usr ) { PA.client.say(dest, "User "+usr.nick+" already exists." ); return; }

	var perm = usrs.length==0?"z":"";

	usr = {
		'nick': nick,
		'host': vhost,
		'permissions': perm
	};

	PA.users.push(usr);
	PA.client.say(dest,"User "+usr.nick+" created successfuly.");
	jf.writeFile("users.json",PA.users,function(){});
}

function _deluserCmd ( from, to, message, messageObj ){
	var dest = to.charAt(0)=='#'?to:from;
	var usrs = PA.users;
	var nick = message[1];
	if ( !usrs ) return;
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }
	PA.users = _.without(PA.users, _.findWhere(PA.users, {'nick': nick}));
	PA.client.say(dest,"Removed user "+nick+".");
	jf.writeFile("users.json",PA.users,function(){});
}

function _addpermCmd ( from, to, message, messageObj ){
	var dest = to.charAt(0)=='#'?to:from;
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

	PA.client.say(dest, "Permission(s) added." );
	jf.writeFile("users.json",PA.users,function(){});
}

function _delpermCmd ( from, to, message, messageObj ){
	var dest = to.charAt(0)=='#'?to:from;
	var usrs = PA.users;
	var nick = message[1];
	var perms = message[2];
	var usr = _.find(usrs, function (usr) { return usr.nick.toLowerCase() == nick.toLowerCase(); });
	if ( !usr ) { PA.client.say(dest, "User "+nick+" doesn't exist." ); return; }

	for ( var i = 0; i < perms.length; i++ ){
		var perm = perms.charAt(i);
		usr.permissions = usr.permissions.replace(perm,'');
	}
	PA.client.say(dest, "Permission(s) removed." );
	jf.writeFile("users.json",PA.users,function(){});
}

function _lsusersCmd ( from, to, message, messageObj ){
	var dest = to.charAt(0)=='#'?to:from;
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

function _whoamiCmd( from, to, message, messageObj ){
	var usr = _.find(PA.users, function(user){ return user.nick.toLowerCase() == from.toLowerCase() ;});
	if ( !usr ) { PA.client.say(from, "You are not in the list." ); return; }
	PA.client.say(from,"N:"+usr.nick+" H:"+usr.host+" F:"+usr.permissions);
}
