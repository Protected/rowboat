<?php

require_once("config.inc.php");

if (!defined('AJAX_REQUEST')) die();

$stats = json_decode(file_get_contents($statspath), true);

$result["userstats"] = $stats["users"];
