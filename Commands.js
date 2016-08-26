//List of Commands
var _ = require('underscore');

var PA = null;
var commandList = [{
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
}];
//Find Command
function getCommand(commandStr){
	return _.find(commandList, function(commandObj) { return commandObj.command == commandStr });
}
//Set Main Instance PA
function setMain(mains){
	PA = mains;
}

function onReassemble(){
	if ( exports.slaveTimer ) {
		exports.slaveTimer.stop();
	}
}
//Exports
exports.commandList = commandList;
exports.onReassemble = onReassemble;
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
function randomIntInc (low, high) {
    return Math.floor(Math.random() * (high - low + 1) + low);
}

// Commands
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
	var str = "Commands: ";
	_.each(PA.commandList, function(commandObj){
		if( PA.checkForPermission(from,messageObj.host,commandObj.permission) ) 
			str += (commandObj.command + " ");
	});
	PA.client.say(from, str);
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

