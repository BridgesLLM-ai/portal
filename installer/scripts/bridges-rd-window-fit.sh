#!/usr/bin/env bash
set -euo pipefail

# Keep windows inside the visible desktop after a noVNC SetDesktopSize request.
sleep 15
last_geometry=""

while true; do
  geometry="$(xdotool getdisplaygeometry 2>/dev/null || true)"
  if [[ -n "$geometry" && "$geometry" != "$last_geometry" ]]; then
    sleep 1
    read -r screen_width screen_height <<<"$geometry"
    margin_top=32
    max_width=$((screen_width - 16))
    max_height=$((screen_height - margin_top - 16))
    (( max_width < 200 )) && max_width=200
    (( max_height < 150 )) && max_height=150

    while read -r window_id desktop x y width height _rest; do
      [[ -z "$window_id" || "$desktop" == "-1" ]] && continue
      new_x=$x
      new_y=$y
      new_width=$width
      new_height=$height
      changed=0

      if (( new_width > max_width )); then new_width=$max_width; changed=1; fi
      if (( new_height > max_height )); then new_height=$max_height; changed=1; fi
      if (( new_x < 0 || new_x + new_width > screen_width )); then
        new_x=$(((screen_width - new_width) / 2))
        (( new_x < 0 )) && new_x=0
        changed=1
      fi
      if (( new_y < margin_top || new_y + new_height > screen_height )); then
        new_y=$margin_top
        changed=1
      fi

      if (( changed == 1 )); then
        wmctrl -i -r "$window_id" -b remove,maximized_vert,maximized_horz 2>/dev/null || true
        wmctrl -i -r "$window_id" -e "0,$new_x,$new_y,$new_width,$new_height" 2>/dev/null || true
      fi
    done < <(wmctrl -l -G 2>/dev/null || true)
    last_geometry="$geometry"
  fi
  sleep 2
done
