"""Blender 4.2+ renderer for Fantasy PKG Studio.

Invocation:
  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python model-render.py -- manifest.json

Directions use camera azimuth around world Z: zero looks from +Y and positive
angles proceed clockwise when viewed from above. Five-direction assets use the
client's stored octants [0, 1, 2, 3, 7], each separated by 45 degrees.
"""

import json
import glob
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector


FRAME_TO_OCT = (0, 1, 2, 3, 7)
MAX_OUTPUT_DIMENSION = 8192
MAX_OUTPUT_PIXELS = 64 * 1024 * 1024
MAX_FRAME_COUNT = 4096
MAX_TIMELINE_SPAN = 4096


def _finite_number(value, name, default=None):
    if value is None and default is not None:
        value = default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("settings.%s must be a number" % name)
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("settings.%s must be finite" % name)
    return value


def _positive_integer(value, name, maximum=MAX_OUTPUT_DIMENSION):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > maximum:
        raise ValueError("%s must be an integer from 1 to %d" % (name, maximum))
    return value


def _frame_integer(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < -1000000 or value > 1000000:
        raise ValueError("%s must be an integer between -1000000 and 1000000" % name)
    return value


def _read_manifest():
    try:
        separator = sys.argv.index("--")
        manifest_path = sys.argv[separator + 1]
    except (ValueError, IndexError):
        raise ValueError("expected a manifest path after --")
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object")
    source = manifest.get("source")
    output = manifest.get("output")
    if not isinstance(source, str) or not os.path.isabs(source) or not os.path.isfile(source):
        raise ValueError("source must be an existing absolute file path")
    if not isinstance(output, str) or not os.path.isabs(output) or not os.path.isdir(output):
        raise ValueError("output must be an existing absolute directory")
    mode = manifest.get("mode")
    if mode not in ("inspect", "render", "edit"):
        raise ValueError("mode must be inspect, render, or edit")
    settings = manifest.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    return source, output, mode, settings, manifest


def _settings(manifest_settings):
    defaults = {
        "width": 256,
        "height": 256,
        "scale": 1,
        "directions": 5,
        "framesPerDirection": 8,
        "startFrame": 1,
        "endFrame": 24,
        "animation": "",
        "azimuth": 0.0,
        "elevation": 30.0,
        "rotationX": 0.0,
        "rotationY": 0.0,
        "rotationZ": 0.0,
        "modelScale": 1.0,
        "offsetX": 0.0,
        "offsetY": 0.0,
        "orthoHeight": 0.0,
        "lightEnergy": 1000.0,
    }
    settings = dict(defaults)
    settings.update(manifest_settings)
    settings["width"] = _positive_integer(settings["width"], "settings.width")
    settings["height"] = _positive_integer(settings["height"], "settings.height")
    settings["scale"] = _positive_integer(settings["scale"], "settings.scale", 8)
    settings["directions"] = _positive_integer(settings["directions"], "settings.directions", 64)
    settings["framesPerDirection"] = _positive_integer(settings["framesPerDirection"], "settings.framesPerDirection", MAX_FRAME_COUNT)
    settings["startFrame"] = _frame_integer(settings["startFrame"], "settings.startFrame")
    settings["endFrame"] = _frame_integer(settings["endFrame"], "settings.endFrame")
    if settings["endFrame"] < settings["startFrame"]:
        raise ValueError("settings.endFrame must be greater than or equal to settings.startFrame")
    if settings["endFrame"] - settings["startFrame"] + 1 > MAX_TIMELINE_SPAN:
        raise ValueError("requested timeline range exceeds %d frames" % MAX_TIMELINE_SPAN)
    if settings["directions"] * settings["framesPerDirection"] > MAX_FRAME_COUNT:
        raise ValueError("direction and frame count exceeds %d output frames" % MAX_FRAME_COUNT)
    physical_width = settings["width"] * settings["scale"]
    physical_height = settings["height"] * settings["scale"]
    if physical_width > MAX_OUTPUT_DIMENSION or physical_height > MAX_OUTPUT_DIMENSION:
        raise ValueError("scaled output dimensions exceed %d pixels" % MAX_OUTPUT_DIMENSION)
    if physical_width * physical_height > MAX_OUTPUT_PIXELS:
        raise ValueError("scaled output pixel count exceeds the output limit")
    for key in ("azimuth", "elevation", "rotationX", "rotationY", "rotationZ", "modelScale",
                "offsetX", "offsetY", "orthoHeight", "lightEnergy"):
        settings[key] = _finite_number(settings[key], key)
    if settings["modelScale"] <= 0:
        raise ValueError("settings.modelScale must be greater than zero")
    if settings["orthoHeight"] < 0:
        raise ValueError("settings.orthoHeight cannot be negative")
    if settings["lightEnergy"] < 0:
        raise ValueError("settings.lightEnergy cannot be negative")
    animation = settings["animation"]
    if not isinstance(animation, str):
        raise ValueError("settings.animation must be a string")
    return settings


def _frame_descriptors(manifest, settings):
    descriptors = manifest.get("frames")
    if descriptors is None:
        return None
    if not isinstance(descriptors, list) or not descriptors:
        raise ValueError("frames must be a non-empty array when provided")
    if len(descriptors) > MAX_FRAME_COUNT:
        raise ValueError("frames exceeds %d descriptors" % MAX_FRAME_COUNT)
    normalized = []
    seen = set()
    for item in descriptors:
        if not isinstance(item, dict):
            raise ValueError("each frame descriptor must be an object")
        index = item.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0 or index >= MAX_FRAME_COUNT:
            raise ValueError("frame index must be an integer from 0 to %d" % (MAX_FRAME_COUNT - 1))
        if index in seen:
            raise ValueError("frame indices must be unique")
        seen.add(index)
        empty = item.get("empty", False)
        if not isinstance(empty, bool):
            raise ValueError("frame.empty must be a boolean")
        width = item.get("width")
        height = item.get("height")
        if empty:
            if width != 0 or height != 0:
                raise ValueError("empty frames must have zero width and height")
        else:
            width = _positive_integer(width, "frame.width")
            height = _positive_integer(height, "frame.height")
            if width * height > MAX_OUTPUT_PIXELS:
                raise ValueError("frame pixel count exceeds the output limit")
        pivot_x = _finite_number(item.get("pivotX"), "frame.pivotX")
        pivot_y = _finite_number(item.get("pivotY"), "frame.pivotY")
        normalized.append({"index": index, "width": width, "height": height,
                           "pivotX": pivot_x, "pivotY": pivot_y, "empty": empty})
    return normalized


def _direction_angles(settings):
    count = settings["directions"]
    base = settings["azimuth"]
    if count == 5:
        return [base + octant * 45.0 for octant in FRAME_TO_OCT]
    return [base + direction * 360.0 / count for direction in range(count)]


def _import_source(source):
    extension = os.path.splitext(source)[1].lower()
    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=source, load_ui=False, use_scripts=False)
        return
    # --factory-startup still contains its default cube, camera and light.
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    if extension in (".gltf", ".glb"):
        if not hasattr(bpy.ops.import_scene, "gltf"):
            raise ValueError("Blender glTF importer is unavailable")
        bpy.ops.import_scene.gltf(filepath=source)
    elif extension == ".fbx":
        if not hasattr(bpy.ops.import_scene, "fbx"):
            try:
                bpy.ops.preferences.addon_enable(module="io_scene_fbx")
            except Exception:
                pass
        if not hasattr(bpy.ops.import_scene, "fbx"):
            raise ValueError("Blender FBX importer is unavailable")
        bpy.ops.import_scene.fbx(filepath=source, use_anim=True)
    elif extension == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=source)
        else:
            bpy.ops.import_scene.obj(filepath=source)
    elif extension == ".stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=source)
        else:
            bpy.ops.import_mesh.stl(filepath=source)
    elif extension == ".ply":
        if hasattr(bpy.ops.wm, "ply_import"):
            bpy.ops.wm.ply_import(filepath=source)
        else:
            bpy.ops.import_mesh.ply(filepath=source)
    else:
        raise ValueError("unsupported 3D source extension: %s" % extension)


def _check_textures(warnings):
    missing = []
    for image in bpy.data.images:
        packed_files = getattr(image, "packed_files", None)
        if (image.source in ("GENERATED", "VIEWER") or image.packed_file is not None or
                (packed_files is not None and len(packed_files) > 0)):
            continue
        try:
            path = bpy.path.abspath(image.filepath, library=image.library)
        except Exception:
            path = bpy.path.abspath(image.filepath)
        exists = os.path.isfile(path) if path else False
        if path and "<UDIM>" in path:
            exists = bool(glob.glob(path.replace("<UDIM>", "[0-9][0-9][0-9][0-9]")))
        if not exists:
            missing.append(image.name)
    if missing:
        sample = ", ".join(missing[:8])
        extra = " (+%d more)" % (len(missing) - 8) if len(missing) > 8 else ""
        raise ValueError("missing external texture files: %s%s" % (sample, extra))


def _animation_info(scene):
    animations = []
    for action in bpy.data.actions:
        if len(animations) >= 256:
            break
        frame_start, frame_end = action.frame_range
        animations.append({"name": action.name, "start": float(frame_start), "end": float(frame_end)})
    animations.sort(key=lambda item: item["name"].casefold())
    return animations


def _select_animation(name):
    if not name:
        return
    action = bpy.data.actions.get(name)
    if action is None:
        raise ValueError("animation action not found: %s" % name)
    animated_objects = []
    for obj in bpy.data.objects:
        animation_data = obj.animation_data
        if animation_data is None:
            continue
        if animation_data.action is not None:
            animated_objects.append(obj)
        if any(track.mute is False for track in animation_data.nla_tracks):
            raise ValueError("cannot safely select an action while active NLA tracks exist")
    if len(animated_objects) != 1:
        raise ValueError("animation selection is ambiguous; source must have one animated object")
    owner = animated_objects[0]
    other_owners = [obj for obj in bpy.data.objects
                    if obj != owner and obj.animation_data is not None and obj.animation_data.action == action]
    if other_owners:
        raise ValueError("animation action is already assigned to another object")
    slots = getattr(action, "slots", None)
    already_selected = owner.animation_data.action == action
    if not already_selected and slots is not None and len(slots) > 1:
        raise ValueError("animation action has multiple slots and cannot be selected unambiguously")
    if not already_selected:
        owner.animation_data.action = action
        if slots is not None and len(slots) == 1 and hasattr(owner.animation_data, "action_slot"):
            owner.animation_data.action_slot = slots[0]


def _scene_objects():
    return list(bpy.context.scene.objects)


def _attach_model_transform(settings, warnings):
    scene = bpy.context.scene
    imported = [obj for obj in _scene_objects() if obj.type not in ("CAMERA", "LIGHT")]
    for obj in _scene_objects():
        if obj.type in ("CAMERA", "LIGHT"):
            obj.hide_render = True
    if not imported:
        raise ValueError("source contains no renderable model objects")
    root_data = bpy.data.objects.new("PKG Studio Model Transform", None)
    scene.collection.objects.link(root_data)
    root_data.empty_display_type = "PLAIN_AXES"
    root_data.rotation_mode = "XYZ"
    roots = [obj for obj in imported if obj.parent is None or obj.parent.type in ("CAMERA", "LIGHT")]
    # Reparent while the new root is identity. Preserving world matrices after
    # assigning a transformed parent would cancel the requested transform.
    for obj in roots:
        old_world = obj.matrix_world.copy()
        obj.parent = root_data
        obj.matrix_world = old_world
    root_data.rotation_euler = tuple(math.radians(settings[key]) for key in ("rotationX", "rotationY", "rotationZ"))
    if len(roots) == 0:
        warnings.append("no unparented objects found for model transform")
    return root_data, imported


def _renderable_objects(imported):
    result = []
    for obj in imported:
        if obj.type in ("MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME") and not obj.hide_render:
            result.append(obj)
    return result


def _object_world_corners(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    matrix = evaluated.matrix_world
    return [matrix @ Vector(corner) for corner in evaluated.bound_box]


def _union_bounds(scene, objects, start, end):
    minimum = Vector((float("inf"),) * 3)
    maximum = Vector((float("-inf"),) * 3)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in objects:
            for corner in _object_world_corners(obj, depsgraph):
                minimum.x = min(minimum.x, corner.x)
                minimum.y = min(minimum.y, corner.y)
                minimum.z = min(minimum.z, corner.z)
                maximum.x = max(maximum.x, corner.x)
                maximum.y = max(maximum.y, corner.y)
                maximum.z = max(maximum.z, corner.z)
    if not all(math.isfinite(value) for value in (*minimum, *maximum)):
        raise ValueError("model has no finite renderable bounds")
    return minimum, maximum


def _bounds_corners(minimum, maximum):
    return [Vector((x, y, z)) for x in (minimum.x, maximum.x)
            for y in (minimum.y, maximum.y) for z in (minimum.z, maximum.z)]


def _anchor_model(root, minimum, maximum):
    center_x = (minimum.x + maximum.x) * 0.5
    center_y = (minimum.y + maximum.y) * 0.5
    root.location = (-center_x, -center_y, -minimum.z)


def _camera_basis(azimuth_degrees, elevation_degrees):
    azimuth = math.radians(azimuth_degrees)
    elevation = math.radians(max(-89.0, min(89.0, elevation_degrees)))
    # Camera position direction: azimuth zero is world +Y; positive turns toward +X.
    direction = Vector((math.sin(azimuth) * math.cos(elevation),
                        math.cos(azimuth) * math.cos(elevation),
                        math.sin(elevation)))
    rotation = (-direction).to_track_quat("-Z", "Y")
    right = rotation @ Vector((1.0, 0.0, 0.0))
    up = rotation @ Vector((0.0, 1.0, 0.0))
    toward_camera = rotation @ Vector((0.0, 0.0, 1.0))
    return rotation, right, up, toward_camera


def _auto_ortho_height(bounds, direction_angles, settings, descriptor):
    minimum, maximum = bounds
    world_corners = _bounds_corners(minimum, maximum)
    width, height = descriptor["width"], descriptor["height"]
    pivot_x, pivot_y = descriptor["pivotX"], descriptor["pivotY"]
    # Physical space available around the normalized ground-origin anchor.
    avail_left = max(1.0, pivot_x)
    avail_right = max(1.0, width - pivot_x)
    avail_up = max(1.0, pivot_y)
    avail_down = max(1.0, height - pivot_y)
    required_height = 0.0
    for angle in direction_angles:
        _, right, up, _ = _camera_basis(angle, settings["elevation"])
        projections_x = [corner.dot(right) for corner in world_corners]
        projections_y = [corner.dot(up) for corner in world_corners]
        # The normalized model anchor is the translated root origin (0,0,0).
        max_right = max(0.0, max(projections_x))
        max_left = max(0.0, -min(projections_x))
        max_up = max(0.0, max(projections_y))
        max_down = max(0.0, -min(projections_y))
        if max_right > 0:
            required_height = max(required_height, max_right * height / avail_right)
        if max_left > 0:
            required_height = max(required_height, max_left * height / avail_left)
        if max_up > 0:
            required_height = max(required_height, max_up * height / avail_up)
        if max_down > 0:
            required_height = max(required_height, max_down * height / avail_down)
    if not math.isfinite(required_height) or required_height <= 0:
        raise ValueError("could not derive an orthographic camera fit")
    return max(1e-6, required_height * 1.08)


def _configure_scene(settings):
    scene = bpy.context.scene
    scene.use_nodes = False
    scene.render.use_sequencer = False
    scene.render.use_border = False
    scene.render.use_crop_to_border = False
    scene.render.use_multiview = False
    scene.render.pixel_aspect_x = 1.0
    scene.render.pixel_aspect_y = 1.0
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.compression = 15
    scene.render.dither_intensity = 0.0
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = settings["width"] * settings["scale"]
    scene.render.resolution_y = settings["height"] * settings["scale"]
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.view_settings.view_transform = "Standard"
    for neutral_look in ("None", "NONE"):
        try:
            scene.view_settings.look = neutral_look
            break
        except (TypeError, ValueError):
            continue
    else:
        raise ValueError("Blender's Standard color view has no neutral look")
    scene.render.use_compositing = False
    world = bpy.data.worlds.new("PKG Studio World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1.0)
        background.inputs["Strength"].default_value = 0.0
    return scene


def _make_camera(scene, descriptor, ortho_height, azimuth, settings):
    camera_data = bpy.data.cameras.new("PKG Studio Orthographic Camera")
    camera = bpy.data.objects.new("PKG Studio Orthographic Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    rotation, right, up, toward_camera = _camera_basis(azimuth, settings["elevation"])
    camera.rotation_mode = "QUATERNION"
    camera.rotation_quaternion = rotation
    camera.data.type = "ORTHO"
    camera.data.sensor_fit = "VERTICAL"
    camera.data.ortho_scale = ortho_height
    camera.data.lens = 50
    width, height = descriptor["width"], descriptor["height"]
    ppu = height / ortho_height
    center_x, center_y = width * 0.5, height * 0.5
    anchor_x, anchor_y = descriptor["pivotX"], descriptor["pivotY"]
    offset_right = (center_x - anchor_x) / ppu
    offset_up = (anchor_y - center_y) / ppu
    camera_distance = max(10.0, ortho_height * 4.0)
    camera.data.clip_end = max(1000.0, camera_distance + ortho_height * 8.0)
    camera.location = right * offset_right + up * offset_up + toward_camera * camera_distance
    return camera


def _make_lighting(scene, bounds, settings):
    minimum, maximum = bounds
    extent = max(maximum.z - minimum.z, maximum.x - minimum.x, maximum.y - minimum.y, 1.0)
    data = bpy.data.lights.new("PKG Studio Key Light", type="AREA")
    # Area-light power must follow scene units so centimetre/meter models bake equally.
    data.energy = settings["lightEnergy"] * extent * extent
    data.shape = "DISK"
    data.size = max(0.5, extent * 1.8)
    light = bpy.data.objects.new("PKG Studio Key Light", data)
    scene.collection.objects.link(light)
    light.location = Vector((extent * 3.5, -extent * 4.5, extent * 6.0))
    target = Vector((0.0, 0.0, extent * 0.45))
    light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()
    fill_data = bpy.data.lights.new("PKG Studio Fill Light", type="AREA")
    fill_data.energy = settings["lightEnergy"] * extent * extent * 0.4
    fill_data.shape = "DISK"
    fill_data.size = extent * 2.5
    fill = bpy.data.objects.new("PKG Studio Fill Light", fill_data)
    scene.collection.objects.link(fill)
    fill.location = Vector((-extent * 3.5, extent * 4.5, extent * 4.0))
    fill.rotation_euler = (target - fill.location).to_track_quat("-Z", "Y").to_euler()


def _save_result(output, result):
    path = os.path.join(output, "result.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, separators=(",", ":"))


def _progress(done, total, message):
    print("FANTASY_PROGRESS " + json.dumps({"done": done, "total": total, "message": message},
                                           ensure_ascii=False, separators=(",", ":")), flush=True)


def _inspect(source, output, settings, warnings):
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        if len(objects) >= 500:
            warnings.append("object metadata truncated at 500 entries")
            break
        objects.append({"name": obj.name[:256], "type": obj.type})
    animations = _animation_info(scene)
    if len(bpy.data.actions) > len(animations):
        warnings.append("animation metadata truncated at 256 entries")
    result = {
        "animations": animations,
        "frameStart": int(scene.frame_start),
        "frameEnd": int(scene.frame_end),
        "objects": objects,
        "warnings": warnings,
    }
    _save_result(output, result)
    _progress(1, 1, "模型信息已读取")


def _edit(source, output, warnings):
    workspace_path = os.path.join(output, "workspace.blend")
    bpy.ops.file.pack_all()
    bpy.ops.file.pack_libraries()
    bpy.ops.wm.save_as_mainfile(filepath=workspace_path, check_existing=False, copy=True)
    result = {"workspace": workspace_path, "objects": len(bpy.context.scene.objects), "warnings": warnings}
    _save_result(output, result)
    _progress(1, 1, "可编辑工程已保存")


def _render(output, settings, manifest, warnings):
    scene = _configure_scene(settings)
    _select_animation(settings["animation"])
    scene_start = settings["startFrame"]
    scene_end = settings["endFrame"]
    scene.frame_start = scene_start
    scene.frame_end = scene_end
    angles = _direction_angles(settings)
    root, imported = _attach_model_transform(settings, warnings)
    renderables = _renderable_objects(imported)
    if not renderables:
        raise ValueError("source has no visible mesh-like objects to render")
    pre_anchor_bounds = _union_bounds(scene, renderables, scene_start, scene_end)
    _anchor_model(root, *pre_anchor_bounds)
    anchor_shift = root.location.copy()
    baseline_bounds = (pre_anchor_bounds[0] + anchor_shift, pre_anchor_bounds[1] + anchor_shift)
    descriptors = _frame_descriptors(manifest, settings)
    total = settings["directions"] * settings["framesPerDirection"]
    preview_index = manifest.get("previewIndex")
    if preview_index is not None:
        if isinstance(preview_index, bool) or not isinstance(preview_index, int) or preview_index < 0 or preview_index >= total:
            raise ValueError("previewIndex must be an output frame index within the requested sequence")
    if descriptors is None:
        physical_width = settings["width"] * settings["scale"]
        physical_height = settings["height"] * settings["scale"]
        descriptors = []
        for index in range(total):
            descriptors.append({"index": index, "width": physical_width, "height": physical_height,
                                "pivotX": physical_width * 0.5 + settings["offsetX"] * settings["scale"],
                                "pivotY": physical_height * 0.85 - settings["offsetY"] * settings["scale"],
                                "empty": False})
    else:
        # Descriptor pivots are physical pixels; user offsets remain logical.
        for descriptor in descriptors:
            descriptor["pivotX"] += settings["offsetX"] * settings["scale"]
            descriptor["pivotY"] -= settings["offsetY"] * settings["scale"]
    if len(descriptors) != total or {item["index"] for item in descriptors} != set(range(total)):
        raise ValueError("frame descriptors must cover every output frame exactly once")
    descriptors.sort(key=lambda item: item["index"])
    for descriptor in descriptors:
        if descriptor["empty"]:
            continue
        if not (0.0 <= descriptor["pivotX"] <= descriptor["width"] and
                0.0 <= descriptor["pivotY"] <= descriptor["height"]):
            warnings.append("frame %d pivot lies outside its canvas; geometry may be clipped" % descriptor["index"])
    indices = {item["index"] for item in descriptors}
    if preview_index is not None and preview_index not in indices:
        raise ValueError("previewIndex is not present in frames")
    selected = [item for item in descriptors if preview_index is None or item["index"] == preview_index]
    if not selected:
        raise ValueError("no frame descriptors selected")
    if len(selected) != len(descriptors):
        warnings.append("preview render used full-sequence animation bounds")
    # A shared world-units-per-physical-pixel ratio keeps sprite size stable
    # across differently cropped frame canvases. Fit at modelScale=1 first;
    # modelScale then remains a meaningful user control.
    visible = [item for item in descriptors if not item["empty"]]
    reference_height = max((item["height"] for item in visible), default=settings["height"] * settings["scale"])
    required_density = max((_auto_ortho_height(baseline_bounds, angles, settings, item) / item["height"]
                            for item in visible), default=1.0 / reference_height)
    automatic_height = required_density * reference_height
    ortho_height = settings["orthoHeight"] or automatic_height
    density = ortho_height / reference_height
    if visible and density < (required_density / 1.08) * settings["modelScale"]:
        warnings.append("chosen model scale and camera height may clip the model")
    model_scale = settings["modelScale"]
    root.scale = (model_scale,) * 3
    root.location = anchor_shift * model_scale
    bounds = (baseline_bounds[0] * model_scale, baseline_bounds[1] * model_scale)
    _make_lighting(scene, bounds, settings)
    output_frames = []
    _progress(0, len(selected), "准备渲染")
    for descriptor in selected:
        index = descriptor["index"]
        direction = index // settings["framesPerDirection"]
        local_frame = index % settings["framesPerDirection"]
        if direction >= len(angles):
            raise ValueError("frame descriptor index exceeds configured direction count")
        blender_frame = scene_start if settings["framesPerDirection"] == 1 else int(round(
            scene_start + local_frame * (scene_end - scene_start) /
            (settings["framesPerDirection"] - 1)
        ))
        scene.frame_set(blender_frame)
        filename = "f%05d.png" % index
        if descriptor["empty"]:
            output_frames.append({"index": index, "file": None, "empty": True})
            _progress(len(output_frames), len(selected), "跳过空帧 %d/%d" % (len(output_frames), len(selected)))
            continue
        scene.render.resolution_x = descriptor["width"]
        scene.render.resolution_y = descriptor["height"]
        scene.render.resolution_percentage = 100
        filepath = os.path.join(output, filename)
        camera = _make_camera(scene, descriptor, density * descriptor["height"], angles[direction], settings)
        scene.render.filepath = filepath
        camera_data = camera.data
        try:
            bpy.ops.render.render(write_still=True)
            output_frames.append({"index": index, "file": filename, "empty": False})
        finally:
            scene.camera = None
            bpy.data.objects.remove(camera, do_unlink=True)
            bpy.data.cameras.remove(camera_data)
        _progress(len(output_frames), len(selected), "已渲染 %d/%d 帧" % (len(output_frames), len(selected)))
    result = {
        "frames": output_frames,
        "frameCount": len(output_frames),
        "directions": settings["directions"],
        "framesPerDirection": settings["framesPerDirection"],
        "frameStart": scene_start,
        "frameEnd": scene_end,
        "orthoHeight": ortho_height,
        "automaticOrthoHeight": automatic_height,
        "modelBounds": {"width": bounds[1].x - bounds[0].x,
                        "depth": bounds[1].y - bounds[0].y,
                        "height": bounds[1].z - bounds[0].z},
        "warnings": warnings,
    }
    _save_result(output, result)


def main():
    if bpy.app.version < (4, 2, 0):
        raise ValueError("Blender 4.2 or newer is required")
    source, output, mode, raw_settings, manifest = _read_manifest()
    settings = _settings(raw_settings)
    warnings = []
    _progress(0, 1, "正在导入模型")
    _import_source(source)
    _check_textures(warnings)
    if mode == "inspect":
        _inspect(source, output, settings, warnings)
    elif mode == "edit":
        _edit(source, output, warnings)
    else:
        _render(output, settings, manifest, warnings)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        try:
            _, output, _, _, _ = _read_manifest()
            _save_result(output, {"error": str(error), "warnings": [], "traceback": traceback.format_exc()[-12000:]})
        except Exception:
            pass
        print("PKG Studio model renderer error: %s" % error, file=sys.stderr)
        raise
