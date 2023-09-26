<?php


function extractFieldName($str) {
    $field = null;
    $value = $str;
    $not = false;

    $skipnext = false;
    $notnext = 0;
    for ($i = 0; $i < strlen($str); $i++) {
        if ($skipnext) {
            $skipnext = false;
            continue;
        }
        $char = substr($str, $i, 1);
        if ($char == '\\') {
            $skipnext = true;
        }
        if ($char == "!") {
            $notnext = 1;
        } else if ($char == "=") {
            if ($notnext) $not = true;
            $field = str_replace("\\", "", substr($str, 0, $i - $notnext));
            $value = substr($str, $i + 1);
            break;
        } else {
            $notnext = 0;
        }
    }

    $value = trim($value);

    if (!$field) {
        if (substr($value, 0, 1) == "!") {
            $not = true;
            $value = substr($value, 1);
        }
    }

    return [$field, $value, $not];
}



/*
    $fields is a list of valid fields.
    Returns $filters, a list in which any element contains a sufficient filter for returning a result.
    The elements of $filters are structured as follows:
    [
        "having" => [               //normal search filter
            ["field" => "match"],
            ...
        ],
        "regex" => [                //regex search filter
            ["field" => "match"],
            ...
        ]
    ]
    Elements are stored as [1, ["field" => "match"]] when negated.
*/

function extractFilterTree($fields, $searchstr) {
    $filters = [];
        

    $prefields = $fields;
    $fields = [];
    foreach ($prefields as $field) {
        $fields[strtolower($field)] = $field;
    }
    

    //Split search string by | as long as it's not inside unescaped {} or [], or escaped itself

    $substrs = [];
    for ($o = 0; $o < strlen($searchstr); ) {

        $skipnext = false;
        $nest = 0;
        $rnest = 0;
        for ($i = $o; $i < strlen($searchstr); $i++) {
            if ($skipnext) {
                $skipnext = false;
                continue;
            }
            $char = substr($searchstr, $i, 1);
            if ($char == '\\') {
                $skipnext = true;
            }
            if ($char == '{' && !$rnest) {
                $nest += 1;
            }
            if ($char == '}' && !$rnest) {
                $nest -= 1;
            }
            if ($char == '[' && !$nest) {
                $rnest += 1;
            }
            if ($char == ']' && !$nest) {
                $rnest += 1;
            }
            if ($char == '|' && !$rnest && !$nest) {
                break;
            }
        }

        $substrs[] = substr($searchstr, $o, $i - $o);
        $o = $i + 1;
    }


    //Extract {} and [] sequences from each substr
    
    foreach ($substrs as $substr) {
        $iresult = [
            "having" => [],
            "regex" => []
        ];

        //Extraction lists for filter elements
        $exthaving = [];
        $extregex = [];

        //Token tracking
        $skipnext = false;
        $having = false;
        $regex = false;

        $rnest = 0;  //keep track of [] inside regex, we don't want to end the regex on the first ]
        $hnest = 0; //keep track of {} inside having
        

        //Prepare lists with the content of each filter by type (equal, having)

        for ($i = 0; $i < strlen($substr); $i++) {

            if ($skipnext) {
                $skipnext = false;
                continue;
            }
            $char = substr($substr, $i, 1);
            if ($char == '\\') {
                $skipnext = true;
            }
            
            
            if ($char == '{') {
                if ($regex === false) {
                    if ($having === false) {
                        $having = ($i + 1);
                        $hnest = 0;
                    } else {
                        $hnest += 1;
                    }
                }
            }

            if ($char == '}') {
                if ($having !== false) {
                    if ($hnest > 0) {
                        $hnest -= 1;
                    } else {
                        $ext = substr($substr, $having, $i - $having);
                        if ($ext) $exthaving[] = $ext;
                        $having = false;
                    }
                }
            }


            if ($char == '[') {
                if ($having === false) {
                    if ($regex === false) {
                        $regex = ($i + 1);
                        $rnest = 0;
                    } else {
                        $rnest += 1;
                    }
                }
            }

            if ($char == ']') {
                if ($regex !== false) {
                    if ($rnest > 0) {
                        $rnest -= 1;
                    } else {
                        $ext = substr($substr, $regex, $i - $regex);
                        if ($ext) $extregex[] = $ext;
                        $regex = false;
                    }
                }
            }

        }
        

        //Extract from each filter the field name (if it exists), correct capitalization, value
        //OR use every known field. Add to results maps.

        foreach ($exthaving as $str) {
            list($field, $value, $not) = extractFieldName($str);
            $block = [];
            if ($field) {
                if (isset($fields[strtolower($field)])) {
                    $block[$fields[strtolower($field)]] = $value;
                }
            } else {
                foreach ($fields as $dfield => $field) {
                    $block[$field] = $value;
                }
            }
            if ($not) $block = [1, $block];
            $iresult["having"][] = $block;
        }


        foreach ($extregex as $str) {
            list($field, $value, $not) = extractFieldName($str);
            $block = [];
            if ($field) {
                if (isset($fields[strtolower($field)])) {
                    $block[$fields[strtolower($field)]] = $value;
                }
            } else {
                foreach ($fields as $dfield => $field) {
                    $block[$field] = $value;
                }
            }
            if ($not) $block = [1, $block];
            $iresult["regex"][] = $block;
        }


        //This is for filters without delimiters (simple search).

        if (!count($iresult["having"]) && !count($iresult["regex"])) {
            $defaultblock = [];
            foreach ($fields as $dfield => $field) {
                $defaultblock[$field] = "*" . preg_replace("/ /", "*", $substr) . "*";
            }
            $iresult["having"][] = $defaultblock;
        }


        $filters[] = $iresult;
    }

    return $filters;
}



function globToRegexPattern($sstr) {
    $detachleft = false;
    $detachright = false;
    if (preg_match("/^\\*(.*)/", $sstr, $match)) {
        $detachleft = true;
        $sstr = $match[1];
    }
    if (preg_match("/(.*)\\*$/", $sstr, $match)) {
        $detachright = true;
        $sstr = $match[1];
    }
    $result = "/^";
    if ($detachleft) $result .= ".*";
    $result .= implode(".*", array_map(function($part) { return preg_quote($part, "/"); }, explode("*", $sstr)));
    if ($detachright) $result .= ".*";
    $result .= "$/i";
    return $result;
}
