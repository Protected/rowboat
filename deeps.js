var _ = require('underscore');

var PA = null;
var mdb = null;
var TDPlayer = null;
var TDShip = null;
var TDPlayerShip = null;
var TDSystem = null;
var TDItem = null;

var tickTimer = null;

var commandList = [{
    command: "join",
    func: _joinCmd,
    help: "Joins the game: The Deeps",
    dest: "any",
},{
	command: "stats",
	func: _statsCmd,
	help: "Gives stats of the player in The Deeps",
	dest: "any",
},{
	command: "warp",
	func: _warpCmd,
	help: "Warps to another system in The Deeps",
	dest: "any",
},{
	command: "deval",
	func: _devalCmd,
	help: "Runs an eval in the deep scope.",
	dest: "any",
	permission: "z",
},{
	command: "tda-ship",
	func: _tdaShipCmd,
	help: "TDA - Changes player ship.",
	syntax: "+tda-ship <player> <ship>",
	dest: "any",
	permission: "d",
	minParams: 2,
},{
	command: "tda-warp",
	func: _tdaWarpCmd,
	help: "TDA - Changes player ship.",
	syntax: "+tda-warp <player> <system>",
	dest: "any",
	permission: "d",
	minParams: 2,
}];


var Players = [];
var PlayerShips = [];
var Ships = [];
var Systems = [];

function setMain(mains){
	PA = mains;
	mdb = PA.mdb;
	var Schema = mdb.Schema;
	var ObjectId = mdb.Schema.ObjectId;
	
	function modelExists( name ) {
		try { 
			var m = mdb.mongoose.model(name);
			if ( m ) return true;
			return false;
		} catch (ex){
			return false;
		}
	}
	
	tickTimer = setInterval( doTick , 1000*60*10 );
	function doTick(){
		if ( TDPlayerShip && TDShip ){
			TDPlayerShip.find({}).populate('Ship').exec(updateAllCapacitors);
			function updateAllCapacitors(err, plShips){
				if ( plShips && plShips.length > 0){
					_.each(plShips, function(plShip){
						plShip.Capacitor += plShip.Ship.CapacitorRecharge;
						if ( plShip.Capacitor > plShip.Ship.MaxCapacitor )
							plShip.Capacitor = plShip.Ship.MaxCapacitor;
						plShip.save(function(){});
					});
					console.log("[TheDeep] Tick!");
					loadPlayers();
				}				
			}
		}
	}
	
	
	try{
		
		var tdShipSchema = new Schema({
			Name: String,
			MaxHP: Number,
			MaxShields: Number,
			MaxFirepower: Number,
			MaxCargo: Number,
			MaxCapacitor: Number,
			CapacitorRecharge:Number,
			Price: Number,
		});
		
		var tdItemSchema = new Schema({
			Name: String,
			Type: Number,
			SellWorth: Number,
			Size: Number,
		});
		
		var tdPlayerShipSchema = new Schema({
			Ship: {type: ObjectId, ref: 'TDShip'},
			HP: Number,
			Shields: Number,
			Cargo: { type: Array, "default": [] },
			Capacitor: Number,
		});
		
		var tdSystemSchema = new Schema ({
			Name: String,
			Security: Number,
			Exits: { type: Array, "default": [] },
			Asteroids: { type: Array, "default": [] },
			PirateDrops: { type: Array, "default": [] },
		});
	
		var tdPlayerSchema = new Schema({
			User: String,
			VHost: String,
			Money: Number,
			Ship: { type: ObjectId, ref: 'TDPlayerShip' },
			Location: { type: ObjectId, ref: 'TDSystem' },
		});
		
		if ( !modelExists('TDPlayer') ){
			TDPlayer = mdb.mongoose.model('TDPlayer',tdPlayerSchema);
		} else {
			TDPlayer = mdb.mongoose.model('TDPlayer');
		}
		if ( !modelExists('TDShip') ){
			TDShip = mdb.mongoose.model('TDShip',tdShipSchema);
		}else {
			TDShip = mdb.mongoose.model('TDShip');
		}
		if ( !modelExists('TDPlayerShip') ){
			TDPlayerShip = mdb.mongoose.model('TDPlayerShip',tdPlayerShipSchema);
		}else {
			TDPlayerShip = mdb.mongoose.model('TDPlayerShip');
		}
		if ( !modelExists('TDSystem') ){
			TDSystem = mdb.mongoose.model('TDSystem',tdSystemSchema);
		}else {
			TDSystem = mdb.mongoose.model('TDSystem');
		}
		if ( !modelExists('TDItem') ){
			TDItem = mdb.mongoose.model('TDItem',tdItemSchema);
		}else {
			TDItem = mdb.mongoose.model('TDItem');
		}
		
		//Ships
		TDShip.findOne( {Name: 'Imp'} , function(err, data) {
			if ( err || !data || data.length == 0 ) {
				var Imp = new TDShip({
					Name: 'Imp',
					MaxHP: 100,
					MaxShields: 200,
					MaxFirepower: 50,
					MaxCargo: 200,
					MaxCapacitor: 500,
					CapacitorRecharge: 25,
					Price: 3000,
				});
				Imp.save(function(err,aff){});
			}
		});
		TDShip.findOne( {Name: 'Fatalis'} , function(err, data) {
			if ( err || !data || data.length == 0 ) {
				var Fatalis = new TDShip({
					Name: 'Fatalis',
					MaxHP: 6E10,
					MaxShields: 6E10,
					MaxFirepower: 6E10,
					MaxCargo: 6E10,
					MaxCapacitor: 6E10,
					CapacitorRecharge: 6E10,
					Price: 9E40,
				});
				Fatalis.save(function(err,aff){});
			}
		});
		//Systems
		TDSystem.findOne({Name: 'Sanctuary'} , function(err,data) {
			if ( err || !data || data.length == 0 ) {
				var Sanctuary = new TDSystem({
					Name: 'Sanctuary',
					Security: 1,
					Exits: [],
					Asteroids: [],
					PirateDrops: [],
				});
				Sanctuary.save(function(err,aff){});
				var Valgrind = new TDSystem({
					Name: 'Valgrind',
					Security: 0.9,
					Exits: [ Sanctuary._id ],
					Asteroids: [],
					PirateDrops: [],
				});
				Valgrind.save(function(err,aff){});
				var Elysium = new TDSystem({
					Name: 'Elysium',
					Security: 0.9,
					Exits: [ Sanctuary._id ],
					Asteroids: [],
					PirateDrops: [],
				});
				Elysium.save(function(err,aff){});
				Sanctuary.Exits = [ Valgrind._id, Elysium._id ];
				Sanctuary.save(function(err,aff){});
				var Gyrth = new TDSystem({
					Name: 'Gyrth',
					Security: 0.6,
					Exits: [ Elysium._id ],
					Asteroids: [],
					PirateDrops: [],
				});
				var Hjoldfadir = new TDSystem({
					Name: 'Hjoldfadir',
					Security: 0.5,
					Exits: [ Elysium._id, Gyrth._id ],
					Asteroids: [],
					PirateDrops: [],
				});
				Gyrth.Exits.push(Hjoldfadir._id);
				Gyrth.save(function(){});
				Hjoldfadir.save(function(){});
				Elysium.Exits.push(Hjoldfadir._id);
				Elysium.Exits.push(Gyrth._id);
				Elysium.save(function(){});
				
			}
		});
		loadSystems();
		setTimeout(loadPlayers,5000);
		
	} catch( ex ) {
		console.log(ex);/*
		TDPlayer = mdb.mongoose.model('TDPlayer');
		TDShip = mdb.mongoose.model('TDShip');
		TDPlayerShip = mdb.mongoose.model('TDPlayerShip');
		TDSystem = mdb.mongoose.model('TDSystem');
		TDItem = mdb.mongoose.model('TDItem');
		*/
	}
	
}

function onReassemble(){
	if ( tickTimer ) {
		clearInterval(tickTimer);
	}
}

exports.commandList = commandList;
exports.setMain = setMain;
exports.onReassemble = onReassemble;

function loadSystems(){
	TDSystem.find({}).exec( loadSystemsIntoGlobal );
	
	function loadSystemsIntoGlobal(err, data){
		Systems = [];
		_.each(data,function(system){
			Systems.push(system.toObject());
		});
	}
}

function loadPlayers(){
	
	TDPlayer.find({}).exec( loadPlayersIntoGlobal );
	
	
	function loadPlayersIntoGlobal(err, data) {
		Players = [];
		_.each(data,function(player){
			var Loc = _.find(Systems, function(sys){
				return sys._id.equals(player.Location);
			});
			var playerObj = player.toObject();
			if ( Loc ) playerObj.Location = Loc;
			Players.push(playerObj);
		});
		TDShip.find({}).exec( loadShipsIntoGlobal );
	}
	function loadShipsIntoGlobal(err, data) {
		Ships = [];
		_.each(data, function(ship){
			Ships.push(ship.toObject());
		});
		TDPlayerShip.find({}).exec( loadPlayerShipsIntoGlobal );
	}
	function loadPlayerShipsIntoGlobal(err, data) {
		PlayerShips = [];
		_.each(data, function(plShip){
			PlayerShips.push(plShip.toObject());
		});
		
		for (var i=0; i<Players.length; i++){
			var shipOf = null;
			for (var j=0; j<PlayerShips.length; j++){
				if ( PlayerShips[j]._id.toString() == Players[i].Ship.toString() ){
					shipOf = PlayerShips[j];
					break;
				}
			}
			if ( shipOf ){
				var pl = Players[i];
				pl['Ship'] = shipOf; 
				
				var ship = _.find(Ships, function(ship){
					return ship._id.equals(pl.Ship.Ship);
				});
				if ( ship ) {
					pl.Ship.Ship = ship;
				}
			}
		}
	}
	
}

function _statsCmd (from, to, dest, message, messageObj) {
	var player = _.find(Players, function(pl){
		return pl.User.toLowerCase() == from.toLowerCase();
	});
	if ( !player ){
		PA.client.say(dest,"You're not in the game. Join with +join.");
		return;
	}
	
	PA.client.say(dest,"Player "+player.User+" is flying a "+player.Ship.Ship.Name+" in the system "+player.Location.Name+" and has "+player.Ship.Capacitor+ "/"+player.Ship.Ship.MaxCapacitor+" cap.");
	
}

function _warpCmd (from, to, dest, message, messageObj) {
	var player = _.find(Players, function(pl){
		return pl.User.toLowerCase() == from.toLowerCase();
	});
	if ( !player ){
		PA.client.say(dest,"You're not in the game. Join with +join.");
		return;
	}
	
	var exits = [];
	_.each(player.Location.Exits, function (exit){
		var exitSys = _.find(Systems, function(sys){
			return sys._id.equals(exit.toString())
		});
		if ( exitSys ) {
			exits.push(exitSys.Name);
		}
	});
	
	if ( message.length < 2 ) {
		PA.client.say(dest,"Exits: "+exits.join(', '));
	} else {
		var destination = message[1];
		
		var destSystem = _.find(exits, function(sys){
			return sys.toLowerCase() == destination.toLowerCase();
		});
		if ( !destSystem ){
			PA.client.say(dest, "There's no exit that matches.");
			return;
		}		
		var chosenSys = _.find(Systems, function(sys){
			return destSystem.toLowerCase() == sys.Name.toLowerCase();
		});
		if ( !chosenSys ){
			PA.client.say(dest, "There's no System that matches.");
			return;
		}
		if ( player.Ship.Capacitor < 25 ){
			PA.client.say(dest, "You don't have enough capacitor energy to make the jump.");
			return;
		}
		
		TDPlayer.findById(player._id, updatePlayer);
		function updatePlayer(err, pl){
			pl.Location = chosenSys._id;
			pl.save(savePlayerAndChangeCap);
		}
		function savePlayerAndChangeCap(err, aff){
			TDPlayerShip.findById(player.Ship._id, changeCap);
		}
		function changeCap(err, plSh){
			plSh.Capacitor -= 25;
			plSh.save(loadPlayers);
			PA.client.say(dest,player.User + " warped into "+destSystem+" successfuly!");
		}
		
	}
	
	
}

function _devalCmd(from,to,dest,message,messageObj ){
	message.splice(0,1);
	var run = message.join(' ');
	try {
		eval(run);
	} catch ( e ) {
		PA.client.say(dest,""+e);
	}

}

function _joinCmd (from, to, dest, message, messageObj) {
	TDPlayer.findOne({User:from}, function(err,data){
		if (data){ PA.client.say(dest,"You're already in the game!") ; loadPlayers(); return;}
		
		TDSystem.findOne({Name: 'Sanctuary'} , function(err,system) {
			if ( err ) return;
			TDShip.findOne( {Name: 'Imp'} , function(err, ship) {
				if ( err ) return;
				
				var playerShip = new TDPlayerShip({
					Ship: ship,
					HP: ship.MaxHP,
					Shields: ship.MaxShields,
					Cargo: [],
					Capacitor: ship.MaxCapacitor,
				});
				playerShip.save(function(){});
				
				var player = new TDPlayer({
					User: from,
					VHost: messageObj.host,
					Money: 1500,
					Ship: playerShip,
					Location: system,
				});
				
				player.save(function(err,aff){
					TDPlayer.findOne({_id:player._id}).populate('Ship').exec(function(err,newPlayer){
						PA.client.say(dest,"You have joined The Deep! Username: "+newPlayer.User+", Money:"+newPlayer.Money+".");
						loadPlayers();
					});
				});
				
			});
		});
		
	});
}

function _tdaShipCmd (from, to, dest, message, messageObj) {
	TDPlayer.findOne({User:message[1]}).populate('Ship').exec(checkForPlayer ); 
	
	var tdPlayer;
	var tdShip;
	
	function checkForPlayer(err,player){
		if (!!err || !player){ 
			PA.client.say(dest,"Player not found.");
			return;
		}
		tdPlayer = player;
		TDShip.findOne( {Name: message[2]} , checkForShip);
	}
	function checkForShip(err,ship){
		if (!!err || !ship){
			PA.client.say(dest,"Ship not found.");
			return;
		}
		tdShip = ship;
		tdPlayer.Ship.Ship = tdShip;
		tdPlayer.Ship.HP = tdShip.MaxHP;
		tdPlayer.Ship.Shields = tdShip.MaxShields;
		tdPlayer.Ship.Capacitor = tdShip.MaxCapacitor;
		tdPlayer.save(savePlayer);
	}
	function savePlayer( err, aff ){
		if(!!err || aff < 1){
			PA.client.say(dest,"Problem saving.");
		}else {
			PA.client.say(dest,"Changed the ship of player "+tdPlayer.User+" into "+tdShip.Name+".");
			loadPlayers();
		}
	}
	
}

function _tdaWarpCmd (from, to, dest, message, messageObj) {
	
}