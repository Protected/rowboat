<?php

require_once("config.inc.php");
require_once("filters.php");

if (!defined('AJAX_REQUEST')) die();


$stats = json_decode(file_get_contents($statspath), true);


$ordercrit = [
     0 => "format",
     1 => "hash",
     2 => "name",
     3 => "author",
     4 => "album",
     5 => "paddedlength",
     6 => "allsharers",
     7 => ["plays"],
     8 => "paddedlastplayed",
     9 => ["kw"],
    10 => ["likenum"],
    11 => ["prioritymeta"]
];


//Use true for a standard match.
//Custom callbacks should return true if the search string matches the field.
$filterfields = [
    "hash" => true,
    "format" => true,
    "sharedBy" => function($pattern, $item) use ($stats) {
        foreach ($item["sharedBy"] as $userid) {
            if (preg_match($pattern, $userid)) return true;
            if ($stats["users"][$userid] && preg_match($pattern, $stats["users"][$userid]["displayname"])) return true;
        }
        return false;
    },
    "length" => true,
    "sourceSpecificId" => true,
    "name" => true,
    "author" => true,
    "album" => true,
    "keywords" => function($pattern, $item) {
        foreach ($item["keywords"] as $kw) {
            if (preg_match($pattern, $kw)) return true;
        }
        return false;
    },
    "like" => function($pattern, $item) use ($stats) {
        if (!isset($item["like"])) return false;
        foreach ($item["like"] as $userid => $like) {
            $ms = $userid . ":";
            if ($like > 0) $ms .= "+";
            $ms .= $like;
            if (preg_match($pattern, $ms)) return true;
            if ($stats["users"][$userid]) {
                $ms = $stats["users"][$userid]["displayname"] . ":";
                if ($like > 0) $ms .= "+";
                $ms .= $like;
                if (preg_match($pattern, $ms)) return true;
            }
        }
        return false;
    },
    "plays" => function($pattern, $item) use ($instancename) {
        if (!isset($item[$instancename . ".rajio.plays"])) return false;
        return preg_match($pattern, $item[$instancename . ".rajio.plays"]);
    },
];



function hoursMinutesAndSeconds($seconds) {
    $h = floor($seconds / 3600);
    if ($h) {
        $seconds -= $h * 3600;
        $m = floor($seconds / 60);
        $s = $seconds % 60;
        return $h . ":" . str_pad($m, 2, "0", STR_PAD_LEFT) . ":" . str_pad($s, 2, "0", STR_PAD_LEFT);
    }
    return minutesAndSeconds($seconds);
}

function minutesAndSeconds($seconds) {
    $m = floor($seconds / 60);
    $s = $seconds % 60;
    return $m . ":" . str_pad($s, 2, "0", STR_PAD_LEFT);
}

function ago($ts) {
    if (!$ts) return "never";
    $delay = time() - $ts;
    $days = floor($delay / 86400);
    $hours = str_pad(floor(($delay % 86400) / 3600), 2, "0", STR_PAD_LEFT);
    $minutes = str_pad(floor(($delay % 3600) / 60), 2, "0", STR_PAD_LEFT);
    $seconds = str_pad($delay % 60, 2, "0", STR_PAD_LEFT);
    return ($days ? $days . "d " : "") . $hours . ":" . $minutes . ":" . $seconds;
}


$index = json_decode(file_get_contents($path), true);
$prefiltering = array_values($index);
$list = [];

$filters = extractFilterTree(array_keys($filterfields), $_REQUEST["search"]["value"]);
foreach ($prefiltering as $i => $item) {
    $accept = false;

    foreach ($filters as $filter) {
    
        $filtermatch = true;
    
        foreach ($filter["having"] as $element) {
            $not = false;
            if (isset($element[0])) {
                $not = true;
                $element = $element[1];
            }
            
            $elematch = false;
            foreach ($element as $field => $sstr) {
                if (!isset($filterfields[$field])) continue;
                $pattern = globToRegexPattern($sstr);
                if ($filterfields[$field] === true) {
                    $elematch = $elematch || preg_match($pattern, $item[$field]);
                } else {
                    $elematch = $elematch || $filterfields[$field]($pattern, $item);
                }
                if ($elematch) break;
            }
            
            if ($not) $elematch = !$elematch;
            $filtermatch = $filtermatch && $elematch;
            if (!$filtermatch) break;
        }
        
        if ($filtermatch) {
            foreach ($filter["regex"] as $element) {
                $not = false;
                if (isset($element[0])) {
                    $not = true;
                    $element = $element[1];
                }
                
                $elematch = false;
                foreach ($element as $field => $sstr) {
                    if (!isset($filterfields[$field])) continue;
                    $pattern = "/" . $sstr . "/i";
                    if ($filterfields[$field] === true) {
                        $elematch = $elematch || preg_match($pattern, $item[$field]);
                    } else {
                        $elematch = $elematch || $filterfields[$field]($pattern, $item);
                    }
                    if ($elematch) break;
                }
                
                if ($not) $elematch = !$elematch;
                $filtermatch = $filtermatch && $elematch;
                if (!$filtermatch) break;
            }
        }
        
        if ($filtermatch) {
            $accept = true;
            break;
        }
    
    }

    if ($accept) $list[] = $item;
}

if (!count($filters)) $list = $prefiltering;


$data = [];

$totlength = 0;
foreach ($list as $i => $info) {

    $likestring = "";
    $likefilterstring = "";
    $likenum = 15000;
    if (isset($info["like"])) foreach ($info["like"] as $userid => $lik) {
        $rawlike = $stats["users"][$userid]["displayname"] . ': ' . $lik;
        $likestring .= '<a href="#" onclick="openUserstats(\'' . $userid . '\'); return false;" title="' . $rawlike . '">' . $likesymbols[$lik] . '</a>';
        $likefilterstring .= $rawlike . " ";
        $likenum += $lik;
        
    }
    
    $plength = str_pad($info["length"], 5, "0", STR_PAD_LEFT);
    $totlength += $info["length"];
    
    $allsharers = [];
    foreach ($info["sharedBy"] as $sharer) {
        $allsharers[] = $stats["users"][$sharer]["displayname"];
        if (isset($info["like"])) foreach ($info["like"] as $userid => $lik) {
            if ($userid == $sharer && $lik > 0) {
                $stats["users"][$sharer]["likeshares"] = ($stats["users"][$sharer]["likeshares"] ?? 0) + 1;
                break;
            }
        }
    }
    $allsharers = implode(", ", $allsharers);
    
    $keywords = array_map(function($keyword) { return htmlspecialchars(str_replace("'", "", $keyword)); }, $info["keywords"]);
    
    $info["name"] = htmlspecialchars($info["name"]);
    $info["author"] = htmlspecialchars($info["author"]);
    $info["album"] = htmlspecialchars($info["album"] ?? "");
    
    $lastplayedmeta = str_pad(0, strlen(PHP_INT_MAX), "0", STR_PAD_LEFT);
    if (isset($info[$instancename . ".rajio.lastplayed"])) {
        $lastplayedmeta = str_pad($info[$instancename . ".rajio.lastplayed"], strlen(PHP_INT_MAX), "0", STR_PAD_LEFT);
    }
    
    $data[] = [
        "format" => $info["format"] ?? "mp3",
        "hash" => $info["hash"],
        "name" => $info["name"],
        "source" => $info["source"],
        "author" => $info["author"],
        "urlauthor" => urlencode($info["author"]),
        "album" => $info["album"],
        "urlalbum" => urlencode($info["author"] . " " . $info["album"]),
        "paddedlength" => $plength,
        "length" => minutesAndSeconds($info["length"]),
        "sharedBy" => $info["sharedBy"][0],
        "allsharers" => $allsharers,
        "plays" => $info[$instancename . ".rajio.plays"] ?? 0,
        "paddedlastplayed" => $lastplayedmeta,
        "lastplayed" => ago($info[$instancename . ".rajio.lastplayed"] ?? 0),
        "kwlist" => $info["keywords"] ?? [],
        "kw" => count($info["keywords"] ?? []),
        "likenum" => $likenum,
        "likestring" => $likestring,
        "likefilterstring" => $likefilterstring,
        "priority" => number_format($stats[$instancename . ".rajio.latestpriorities"][$info["hash"]] ?? 0, 1, ".", ""),
        "prioritymeta" => $stats[$instancename . ".rajio.latestpriorities"][$info["hash"]] ?? 0,
    ];
        
}


foreach ($_REQUEST["order"] as $order) {
    usort($data, function ($a, $b) use ($order, $ordercrit) {
        $crit = $ordercrit[$order["column"]];
        if ($order["dir"] == "asc") {
            if (is_array($crit)) {
                if ($a[$crit[0]] < $b[$crit[0]]) return 1;
                if ($a[$crit[0]] > $b[$crit[0]]) return -1;
            } else {
                return strcasecmp($a[$crit], $b[$crit]);
            }
        } else {
            if (is_array($crit)) {
                if ($a[$crit[0]] > $b[$crit[0]]) return 1;
                if ($a[$crit[0]] < $b[$crit[0]]) return -1;
            } else {
                return strcasecmp($b[$crit], $a[$crit]);
            }
        }
        return 0;
    });
}


$result["draw"] = $_REQUEST["draw"] * 1;
$result["data"] = $data;
$result["recordsTotal"] = count($index);
$result["recordsFiltered"] = count($data);
$result["totalLength"] = hoursMinutesAndSeconds($totlength);
