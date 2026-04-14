"""
Utility for extracting metadata from archived images and updating database records.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LOGGER = logging.getLogger(__name__)

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False
    LOGGER.warning("Pillow not available. Metadata extraction from images will not work.")


def _extract_metadata_from_png(image_path: Path) -> Optional[Dict[str, Any]]:
    """
    Extract metadata from a PNG image file.
    """
    if not PIL_AVAILABLE:
        LOGGER.warning(f"[PHG] Pillow not available for {image_path}")
        return None
    
    if not image_path.exists():
        LOGGER.warning(f"Image file does not exist: {image_path}")
        return None
    
    try:
        with Image.open(image_path) as img:
            metadata = {}
            
            # Log image info for debugging
            LOGGER.debug(f"[PHG] Processing image: {image_path.name}, format: {img.format}")
            
            if hasattr(img, 'info') and img.info:
                LOGGER.debug(f"[PHG] Image info keys for {image_path.name}: {list(img.info.keys())}")
                
                # 1. Check for 'prompt' key (ComfyUI format - contains node data with parameters)
                # This is the primary source for generation parameters in ComfyUI
                if 'prompt' in img.info:
                    prompt_text = img.info['prompt']
                    if prompt_text:
                        try:
                            workflow_data = json.loads(prompt_text)
                            if isinstance(workflow_data, dict):
                                parsed = _parse_comfyui_workflow(workflow_data)
                                if parsed:
                                    metadata.update(parsed)
                                    LOGGER.info(f"[PHG] Parsed {len(parsed)} parameters from ComfyUI prompt in {image_path.name}: {list(parsed.keys())}")
                                else:
                                    LOGGER.debug(f"[PHG] No parameters found in ComfyUI prompt for {image_path.name}")
                        except json.JSONDecodeError as e:
                            LOGGER.debug(f"[PHG] Failed to parse ComfyUI prompt JSON in {image_path.name}: {e}")
                
                # 2. Check for 'workflow' key (ComfyUI full workflow schema)
                # We store this for reference, but 'prompt' is better for parameters
                if 'workflow' in img.info:
                    try:
                        workflow_data = json.loads(img.info['workflow'])
                        # Only store if we haven't found params yet, or for backup
                        if not metadata:
                             metadata['_comfyui_full_workflow'] = workflow_data
                             LOGGER.debug(f"[PHG] Stored full workflow schema for {image_path.name} (no params found yet)")
                    except json.JSONDecodeError:
                        pass
                
                # 3. Check for 'parameters' key (SD WebUI format)
                if 'parameters' in img.info:
                    params_text = img.info['parameters']
                    if params_text:
                        parsed = _parse_sd_parameters(params_text)
                        if parsed:
                            metadata.update(parsed)
                            LOGGER.info(f"[PHG] Parsed {len(parsed)} parameters from SD WebUI format in {image_path.name}")
            
            # If we found any useful metadata (excluding just the full workflow schema), return it
            useful_metadata = {k: v for k, v in metadata.items() if k != '_comfyui_full_workflow'}
            
            if useful_metadata:
                return metadata # Return full metadata including workflow if needed elsewhere
            else:
                if '_comfyui_full_workflow' in metadata:
                     LOGGER.warning(f"[PHG] Only full workflow schema found in {image_path.name}, no generation parameters extracted.")
                else:
                     LOGGER.warning(f"[PHG] No metadata found in {image_path.name}")
                return None
            
    except Exception as e:
        LOGGER.error(f"Error extracting metadata from {image_path}: {e}", exc_info=True)
        return None


def _parse_comfyui_workflow(workflow_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Parse ComfyUI workflow data (from 'prompt' key) and extract generation parameters.
    
    Expected format: dictionary of nodes { "node_id": { "class_type": "...", "inputs": {...}, "widgets_values": [...] } }
    """
    if not isinstance(workflow_data, dict):
        return {}
    
    result = {}
    found_sampler = False
    found_resolution = False
    found_model = False
    found_seed = False
    loras = []
    controlnets = []
    upscale_models = []

    # Iterate through all nodes to find relevant ones
    for node_id, node_data in workflow_data.items():
        if not isinstance(node_data, dict):
            continue
            
        class_type = node_data.get('class_type', '')
        
        # Prefer widgets_values if available, otherwise look in inputs
        widgets_values = node_data.get('widgets_values', [])
        inputs = node_data.get('inputs', {})

        if not widgets_values and not inputs:
            continue
        
        # --- PromptHistoryInput ---
        # Skip prompt and negative_prompt extraction as they are already saved separately via the node
        # We only extract other useful metadata if present in this node
        if class_type == 'PromptHistoryInput':
            # Do NOT extract prompt/negative_prompt from here - they come from the node directly
            LOGGER.debug(f"[PHG] Skipping prompt extraction from PromptHistoryInput (already saved)")
            continue
        
        # --- LoRA Loaders ---
        # Extract LoRA models from various loader types
        if class_type in ['Power Lora Loader (rgthree)', 'LoraLoader', 'LoraLoaderModelOnly', 'ZImageSelectiveLoRALoader']:
            try:
                if class_type == 'Power Lora Loader (rgthree)':
                    # Parse Power Lora Loader format with multiple lora slots
                    for i in range(1, 20):  # Support up to 20 LoRA slots
                        lora_key = f'lora_{i}'
                        if lora_key in inputs:
                            lora_data = inputs[lora_key]
                            if isinstance(lora_data, dict) and lora_data.get('on', False):
                                lora_name = lora_data.get('lora', '')
                                strength = lora_data.get('strength', 1.0)
                                if lora_name:
                                    lora_basename = lora_name.split('/')[-1].split('\\')[-1]
                                    loras.append({'name': lora_basename, 'strength': strength})
                elif class_type in ['LoraLoader', 'LoraLoaderModelOnly']:
                    if 'lora_name' in inputs and 'strength_model' in inputs:
                        lora_path = str(inputs['lora_name'])
                        strength = float(inputs.get('strength_model', 1.0))
                        lora_basename = lora_path.split('/')[-1].split('\\')[-1]
                        if lora_basename and strength != 0:
                            loras.append({'name': lora_basename, 'strength': strength})
                elif class_type == 'ZImageSelectiveLoRALoader':
                    if 'lora_name' in inputs and 'strength' in inputs:
                        lora_path = str(inputs['lora_name'])
                        strength = float(inputs.get('strength', 1.0))
                        lora_basename = lora_path.split('/')[-1].split('\\')[-1]
                        if lora_basename and strength != 0:
                            loras.append({'name': lora_basename, 'strength': strength})
                
                if loras:
                    result['loras'] = loras
                    LOGGER.debug(f"[PHG] Parsed {len(loras)} LoRA(s): {[l['name'] for l in loras]}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing LoRA values: {e}")
            continue
        
        # --- ControlNet / Model Patch Loaders ---
        if class_type in ['ControlNetLoader', 'ModelPatchLoader', 'DiffControlNetLoader']:
            try:
                model_name = None
                if 'control_net_name' in inputs:
                    model_path = str(inputs['control_net_name'])
                    model_name = model_path.split('/')[-1].split('\\')[-1]
                elif 'name' in inputs:
                    model_path = str(inputs['name'])
                    model_name = model_path.split('/')[-1].split('\\')[-1]
                
                if model_name:
                    controlnets.append(model_name)
                    result['controlnets'] = controlnets
                    LOGGER.debug(f"[PHG] Parsed ControlNet/ModelPatch: {model_name}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing ControlNet values: {e}")
            continue
        
        # --- Upscale Model Loaders ---
        if class_type in ['UpscaleModelLoader']:
            try:
                if 'model_name' in inputs:
                    model_path = str(inputs['model_name'])
                    model_name = model_path.split('/')[-1].split('\\')[-1]
                    if model_name:
                        upscale_models.append(model_name)
                        result['upscale_models'] = upscale_models
                        LOGGER.debug(f"[PHG] Parsed Upscale Model: {model_name}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing UpscaleModel values: {e}")
            continue
        
        # --- SamplerCustomAdvanced / SamplerCustom / ClownsharKSampler_Beta / DetailDaemonSamplerNode / KSampler (Efficient) ---
        # Extract sampler parameters from various sampler node types
        if class_type in ['SamplerCustomAdvanced', 'SamplerCustom', 'ClownsharKSampler_Beta', 'DetailDaemonSamplerNode', 'KSampler (Efficient)', 'SamplerEulerAncestral'] and not found_sampler:
            try:
                # Try to extract common sampler parameters from inputs
                if 'seed' in inputs:
                    result['seed'] = int(float(inputs['seed']))
                    found_seed = True
                if 'steps' in inputs:
                    result['steps'] = int(float(inputs['steps']))
                if 'cfg' in inputs:
                    result['cfg'] = float(inputs['cfg'])
                if 'sampler_name' in inputs:
                    result['sampler_name'] = str(inputs['sampler_name'])
                if 'scheduler' in inputs:
                    result['scheduler'] = str(inputs['scheduler'])
                if 'denoise' in inputs:
                    result['denoise'] = float(inputs['denoise'])
                if 'eta' in inputs:
                    result['eta'] = float(inputs['eta'])
                # ClownsharKSampler_Beta specific parameters
                if 's_noise' in inputs:
                    result['s_noise'] = float(inputs['s_noise'])
                if 'bongmath' in inputs:
                    result['bongmath'] = inputs['bongmath']
                if 'sampler_mode' in inputs:
                    result['sampler_mode'] = str(inputs['sampler_mode'])
                # DetailDaemon parameters
                if 'detail_amount' in inputs:
                    result['detail_amount'] = float(inputs['detail_amount'])
                if 'bias' in inputs:
                    result['detail_bias'] = float(inputs['bias'])
                if 'exponent' in inputs:
                    result['detail_exponent'] = float(inputs['exponent'])
                
                if any(k in result for k in ['seed', 'steps', 'cfg', 'sampler_name']):
                    found_sampler = True
                    LOGGER.debug(f"[PHG] Parsed {class_type}: seed={result.get('seed')}, steps={result.get('steps')}, cfg={result.get('cfg')}")
            except Exception as e:
                LOGGER.debug(f"[PHG] Error processing {class_type}: {e}")
        
        # --- KSamplerSelect ---
        # Extract sampler name from KSamplerSelect node
        elif class_type == 'KSamplerSelect':
            try:
                if 'sampler_name' in inputs:
                    result['sampler_name'] = str(inputs['sampler_name'])
                    LOGGER.debug(f"[PHG] Parsed KSamplerSelect: {result['sampler_name']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing KSamplerSelect values: {e}")
        
        # --- BasicScheduler / Flux2Scheduler / SDTurboScheduler / SDEditScheduler / BetaSamplingScheduler / AlignYourStepsScheduler / FlowMatchEulerDiscreteScheduler ---
        # Extract scheduler parameters
        elif class_type in ['BasicScheduler', 'Flux2Scheduler', 'SDTurboScheduler', 'SDEditScheduler', 'BetaSamplingScheduler', 'AlignYourStepsScheduler', 'FlowMatchEulerDiscreteScheduler (Custom)']:
            try:
                if 'scheduler' in inputs:
                    result['scheduler'] = str(inputs['scheduler'])
                if 'steps' in inputs:
                    result['steps'] = int(float(inputs['steps']))
                if 'denoise' in inputs:
                    result['denoise'] = float(inputs['denoise'])
                if 'width' in inputs:
                    result['width'] = int(float(inputs['width']))
                if 'height' in inputs:
                    result['height'] = int(float(inputs['height']))
                # BetaSamplingScheduler specific
                if 'alpha' in inputs:
                    result['beta_alpha'] = float(inputs['alpha'])
                if 'beta' in inputs:
                    result['beta_beta'] = float(inputs['beta'])
                # AlignYourStepsScheduler specific
                if 'model_type' in inputs:
                    result['ays_model_type'] = str(inputs['model_type'])
                # FlowMatchEulerDiscreteScheduler specific
                if 'shift' in inputs:
                    result['flow_shift'] = float(inputs['shift'])
                if 'base_shift' in inputs:
                    result['flow_base_shift'] = float(inputs['base_shift'])
                if 'max_shift' in inputs:
                    result['flow_max_shift'] = float(inputs['max_shift'])
                if 'time_shift_type' in inputs:
                    result['time_shift_type'] = str(inputs['time_shift_type'])
                LOGGER.debug(f"[PHG] Parsed {class_type}: scheduler={result.get('scheduler')}, steps={result.get('steps')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- SamplerCustomAdvanced (legacy handling) ---
        # SamplerCustomAdvanced doesn't have direct parameters, they come from connected nodes
        # But we can mark that we found a sampler and try to get data from linked nodes
        elif class_type == 'SamplerCustomAdvanced' and not found_sampler:
            try:
                # Try to extract from inputs if any direct values exist
                if 'seed' in inputs:
                    result['seed'] = int(float(inputs['seed']))
                    found_seed = True
                if 'steps' in inputs:
                    result['steps'] = int(float(inputs['steps']))
                if 'cfg' in inputs:
                    result['cfg'] = float(inputs['cfg'])
                if 'sampler_name' in inputs:
                    result['sampler_name'] = str(inputs['sampler_name'])
                if 'scheduler' in inputs:
                    result['scheduler'] = str(inputs['scheduler'])
                if 'denoise' in inputs:
                    result['denoise'] = float(inputs['denoise'])
                
                found_sampler = True
                LOGGER.debug(f"[PHG] Found SamplerCustomAdvanced node with params: seed={result.get('seed')}, steps={result.get('steps')}")
            except Exception as e:
                LOGGER.debug(f"[PHG] Error processing SamplerCustomAdvanced: {e}")
        
        # --- Flux2Scheduler or similar scheduler nodes ---
        # Extract steps, width, height from scheduler nodes
        elif 'Scheduler' in class_type and not found_resolution:
            try:
                width = None
                height = None
                steps = None
                
                if 'width' in inputs:
                    width = int(float(inputs['width']))
                if 'height' in inputs:
                    height = int(float(inputs['height']))
                if 'steps' in inputs:
                    steps = int(float(inputs['steps']))
                
                if width and height:
                    result['width'] = width
                    result['height'] = height
                    found_resolution = True
                    LOGGER.debug(f"[PHG] Parsed {class_type}: {width}x{height}")
                
                if steps is not None:
                    result['steps'] = steps
                    LOGGER.debug(f"[PHG] Parsed steps from {class_type}: {steps}")
                    
            except (ValueError, TypeError, IndexError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- RandomNoise / GenerateNoise / ttN seed / easy seed / Seed (rgthree) ---
        # Extract seed from various noise/seed nodes
        elif class_type in ['RandomNoise', 'GenerateNoise', 'ttN seed', 'easy seed', 'Seed (rgthree)', 'RBG_Smart_Seed_Variance'] and not found_seed:
            try:
                seed_value = None
                # Check different field names for seed
                for field_name in ['noise_seed', 'seed', 'value', 'seed_value']:
                    if field_name in inputs:
                        seed_value = int(float(inputs[field_name]))
                        break
                
                if seed_value is not None:
                    result['seed'] = seed_value
                    found_seed = True
                    LOGGER.debug(f"[PHG] Parsed seed from {class_type}: {result['seed']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- CFGGuider / BasicGuider ---
        # Extract CFG scale from guider nodes
        elif class_type in ['CFGGuider', 'BasicGuider']:
            try:
                if 'cfg' in inputs:
                    result['cfg'] = float(inputs['cfg'])
                    LOGGER.debug(f"[PHG] Parsed CFG from {class_type}: {result['cfg']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- UNETLoader / UnetLoaderGGUF / ClipLoaderGGUF / AILab_QwenVL_GGUF ---
        # Extract model name from various model loader types
        elif class_type in ['UNETLoader', 'UnetLoaderGGUF', 'ClipLoaderGGUF', 'AILab_QwenVL_GGUF'] and not found_model:
            try:
                model_name = None
                # Check for different input field names used by different loaders
                for field_name in ['unet_name', 'clip_name', 'model_name', 'ckpt_name']:
                    if field_name in inputs:
                        model_path = str(inputs[field_name])
                        model_name = model_path.split('/')[-1].split('\\')[-1]
                        break
                
                if model_name:
                    result['model_name'] = model_name
                    found_model = True
                    LOGGER.debug(f"[PHG] Parsed {class_type}: {model_name}")
            except (ValueError, TypeError, IndexError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- DualCLIPLoader ---
        # Extract CLIP model names from dual loader
        elif class_type == 'DualCLIPLoader':
            try:
                clip_names = []
                for field_name in ['clip_name1', 'clip_name2', 'clip_name_1', 'clip_name_2']:
                    if field_name in inputs:
                        clip_path = str(inputs[field_name])
                        clip_name = clip_path.split('/')[-1].split('\\')[-1]
                        if clip_name:
                            clip_names.append(clip_name)
                if clip_names:
                    result['clip_name'] = ' + '.join(clip_names)
                    LOGGER.debug(f"[PHG] Parsed DualCLIPLoader: {result['clip_name']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing DualCLIPLoader values: {e}")
        
        # --- CLIPLoader ---
        # Extract CLIP model name
        elif class_type == 'CLIPLoader':
            try:
                if 'clip_name' in inputs:
                    clip_path = str(inputs['clip_name'])
                    result['clip_name'] = clip_path.split('/')[-1].split('\\')[-1]
                    LOGGER.debug(f"[PHG] Parsed CLIP from CLIPLoader: {result['clip_name']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing CLIPLoader values: {e}")
        
        # --- VAELoader ---
        # Extract VAE name
        elif class_type == 'VAELoader':
            try:
                if 'vae_name' in inputs:
                    vae_path = str(inputs['vae_name'])
                    result['vae_name'] = vae_path.split('/')[-1].split('\\')[-1]
                    LOGGER.debug(f"[PHG] Parsed VAE from VAELoader: {result['vae_name']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing VAELoader values: {e}")
        
        # --- KSamplerAdvanced or KSampler ---
        elif class_type in ['KSamplerAdvanced', 'KSampler'] and not found_sampler:
            try:
                # Logic for KSamplerAdvanced: [add_noise, seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise, ...]
                if class_type == 'KSamplerAdvanced' and len(widgets_values) >= 7:
                    if isinstance(widgets_values[0], str) and widgets_values[0] in ['enable', 'disable']:
                        result['seed'] = int(float(widgets_values[1]))
                        result['steps'] = int(float(widgets_values[3]))
                        result['cfg'] = float(widgets_values[4])
                        result['sampler_name'] = str(widgets_values[5])
                        result['scheduler'] = str(widgets_values[6]) if len(widgets_values) > 6 else 'normal'
                        if len(widgets_values) > 7:
                            result['denoise'] = float(widgets_values[7])
                        found_sampler = True
                        LOGGER.debug(f"[PHG] Parsed {class_type} (widgets): seed={result['seed']}, steps={result['steps']}")
                
                # Logic for standard KSampler: [seed, control_after_generate, steps, cfg, sampler_name, scheduler]
                elif class_type == 'KSampler' and len(widgets_values) >= 6:
                    result['seed'] = int(float(widgets_values[0]))
                    result['steps'] = int(float(widgets_values[2]))
                    result['cfg'] = float(widgets_values[3])
                    result['sampler_name'] = str(widgets_values[4])
                    result['scheduler'] = str(widgets_values[5])
                    found_sampler = True
                    LOGGER.debug(f"[PHG] Parsed {class_type} (widgets): seed={result['seed']}, steps={result['steps']}")
                
                # Fallback: Try to get from 'inputs' if widgets_values is missing or incomplete
                if not found_sampler:
                    if 'noise_seed' in inputs: result['seed'] = int(float(inputs['noise_seed']))
                    if 'steps' in inputs: result['steps'] = int(float(inputs['steps']))
                    if 'cfg' in inputs: result['cfg'] = float(inputs['cfg'])
                    if 'sampler_name' in inputs: result['sampler_name'] = str(inputs['sampler_name'])
                    if 'scheduler' in inputs: result['scheduler'] = str(inputs['scheduler'])
                    if 'denoise' in inputs: result['denoise'] = float(inputs['denoise'])
                    
                    if 'seed' in result or 'steps' in result:
                        found_sampler = True
                        LOGGER.debug(f"[PHG] Parsed {class_type} (inputs): seed={result.get('seed')}, steps={result.get('steps')}")

            except (ValueError, TypeError, IndexError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- FaceDetailer / Detailer (Impact Pack) ---
        # Extract FaceDetailer parameters for detailed inpainting workflows
        elif class_type in ['FaceDetailer', 'Detailer']:
            try:
                detailer_name = node_data.get('_meta', {}).get('title', 'FaceDetailer')
                if 'guide_size' in inputs:
                    result[f'{detailer_name}_guide_size'] = float(inputs['guide_size'])
                if 'steps' in inputs:
                    result[f'{detailer_name}_steps'] = int(inputs['steps'])
                if 'cfg' in inputs:
                    result[f'{detailer_name}_cfg'] = float(inputs['cfg'])
                if 'denoise' in inputs:
                    result[f'{detailer_name}_denoise'] = float(inputs['denoise'])
                if 'sampler_name' in inputs:
                    result[f'{detailer_name}_sampler'] = str(inputs['sampler_name'])
                if 'scheduler' in inputs:
                    result[f'{detailer_name}_scheduler'] = str(inputs['scheduler'])
                if 'bbox_detector' in inputs or 'segm_detector_opt' in inputs:
                    detector = inputs.get('bbox_detector', inputs.get('segm_detector_opt', ''))
                    if isinstance(detector, list) and len(detector) > 0:
                        # It's a node reference, we can't get the name directly from here
                        result[f'{detailer_name}_uses_detector'] = True
                    elif isinstance(detector, str) and detector:
                        result[f'{detailer_name}_detector'] = detector
                if 'sam_model_opt' in inputs:
                    sam_ref = inputs['sam_model_opt']
                    if isinstance(sam_ref, list) and len(sam_ref) > 0:
                        result[f'{detailer_name}_uses_sam'] = True
                if 'feather' in inputs:
                    result[f'{detailer_name}_feather'] = int(inputs['feather'])
                if 'bbox_threshold' in inputs:
                    result[f'{detailer_name}_bbox_threshold'] = float(inputs['bbox_threshold'])
                if 'bbox_dilation' in inputs:
                    result[f'{detailer_name}_bbox_dilation'] = int(inputs['bbox_dilation'])
                LOGGER.debug(f"[PHG] Parsed {detailer_name}: steps={result.get(f'{detailer_name}_steps')}, denoise={result.get(f'{detailer_name}_denoise')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- UltimateSDUpscale ---
        # Extract Ultimate SD Upscale parameters
        elif class_type == 'UltimateSDUpscale':
            try:
                if 'upscale_by' in inputs:
                    result['usd_upscale_by'] = float(inputs['upscale_by'])
                if 'steps' in inputs:
                    result['usd_steps'] = int(inputs['steps'])
                if 'cfg' in inputs:
                    result['usd_cfg'] = float(inputs['cfg'])
                if 'sampler_name' in inputs:
                    result['usd_sampler'] = str(inputs['sampler_name'])
                if 'scheduler' in inputs:
                    result['usd_scheduler'] = str(inputs['scheduler'])
                if 'denoise' in inputs:
                    result['usd_denoise'] = float(inputs['denoise'])
                if 'mode_type' in inputs:
                    result['usd_mode'] = str(inputs['mode_type'])
                if 'tile_width' in inputs:
                    result['usd_tile_width'] = int(inputs['tile_width'])
                if 'tile_height' in inputs:
                    result['usd_tile_height'] = int(inputs['tile_height'])
                if 'seam_fix_mode' in inputs:
                    result['usd_seam_fix_mode'] = str(inputs['seam_fix_mode'])
                LOGGER.debug(f"[PHG] Parsed UltimateSDUpscale: scale={result.get('usd_upscale_by')}, mode={result.get('usd_mode')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing UltimateSDUpscale values: {e}")
        
        # --- SeedVR2VideoUpscaler / SeedVR2LoadDiTModel / SeedVR2LoadVAEModel ---
        # Extract SeedVR2 upscaler parameters
        elif class_type in ['SeedVR2VideoUpscaler', 'SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel']:
            try:
                if class_type == 'SeedVR2VideoUpscaler':
                    if 'resolution' in inputs:
                        result['seedvr2_resolution'] = int(inputs['resolution'])
                    if 'input_noise_scale' in inputs:
                        result['seedvr2_noise_scale'] = float(inputs['input_noise_scale'])
                    if 'color_correction' in inputs:
                        result['seedvr2_color_correction'] = str(inputs['color_correction'])
                    if 'dit' in inputs or 'vae' in inputs:
                        result['uses_seedvr2'] = True
                elif class_type == 'SeedVR2LoadDiTModel':
                    if 'model' in inputs:
                        model_path = str(inputs['model'])
                        model_name = model_path.split('/')[-1].split('\\')[-1]
                        result['seedvr2_dit_model'] = model_name
                elif class_type == 'SeedVR2LoadVAEModel':
                    if 'model' in inputs:
                        model_path = str(inputs['model'])
                        model_name = model_path.split('/')[-1].split('\\')[-1]
                        result['seedvr2_vae_model'] = model_name
                LOGGER.debug(f"[PHG] Parsed SeedVR2 component: {class_type}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing SeedVR2 values: {e}")
        
        # --- PatchModelAddDownscale (Kohya Deep Shrink) ---
        # Extract patch model downscale parameters
        elif class_type == 'PatchModelAddDownscale':
            try:
                if 'block_number' in inputs:
                    result['patch_block_number'] = int(inputs['block_number'])
                if 'downscale_factor' in inputs:
                    result['patch_downscale_factor'] = float(inputs['downscale_factor'])
                if 'start_percent' in inputs:
                    result['patch_start_percent'] = float(inputs['start_percent'])
                if 'end_percent' in inputs:
                    result['patch_end_percent'] = float(inputs['end_percent'])
                LOGGER.debug(f"[PHG] Parsed PatchModelAddDownscale: block={result.get('patch_block_number')}, factor={result.get('patch_downscale_factor')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing PatchModelAddDownscale values: {e}")
        
        # --- LGNoiseInjectionLatent ---
        # Extract noise injection parameters
        elif class_type == 'LGNoiseInjectionLatent':
            try:
                if 'strength' in inputs:
                    result['noise_injection_strength'] = float(inputs['strength'])
                if 'start_percent' in inputs:
                    result['noise_start_percent'] = float(inputs['start_percent'])
                if 'end_percent' in inputs:
                    result['noise_end_percent'] = float(inputs['end_percent'])
                LOGGER.debug(f"[PHG] Parsed LGNoiseInjectionLatent: strength={result.get('noise_injection_strength')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing LGNoiseInjectionLatent values: {e}")
        
        # --- SeedVarianceEnhancer ---
        # Extract seed variance enhancement parameters
        elif class_type == 'SeedVarianceEnhancer':
            try:
                if 'randomize_percent' in inputs:
                    result['variance_randomize_percent'] = float(inputs['randomize_percent'])
                if 'strength' in inputs:
                    result['variance_strength'] = float(inputs['strength'])
                if 'noise_insert' in inputs:
                    result['variance_noise_insert'] = str(inputs['noise_insert'])
                if 'steps_switchover_percent' in inputs:
                    result['variance_switchover_percent'] = float(inputs['steps_switchover_percent'])
                LOGGER.debug(f"[PHG] Parsed SeedVarianceEnhancer: strength={result.get('variance_strength')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing SeedVarianceEnhancer values: {e}")
        
        # --- DifferentialDiffusion ---
        # Mark that differential diffusion was used
        elif class_type == 'DifferentialDiffusion':
            try:
                if 'strength' in inputs:
                    result['diffusion_strength'] = float(inputs['strength'])
                result['uses_differential_diffusion'] = True
                LOGGER.debug(f"[PHG] Detected DifferentialDiffusion: strength={result.get('diffusion_strength')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing DifferentialDiffusion values: {e}")
        
        # --- QwenMultiangleCameraNode ---
        # Extract camera control parameters
        elif class_type == 'QwenMultiangleCameraNode':
            try:
                if 'horizontal_angle' in inputs:
                    result['camera_horizontal_angle'] = int(inputs['horizontal_angle'])
                if 'vertical_angle' in inputs:
                    result['camera_vertical_angle'] = int(inputs['vertical_angle'])
                if 'zoom' in inputs:
                    result['camera_zoom'] = float(inputs['zoom'])
                result['uses_camera_control'] = True
                LOGGER.debug(f"[PHG] Parsed QwenMultiangleCameraNode: angle={result.get('camera_horizontal_angle')}, zoom={result.get('camera_zoom')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing QwenMultiangleCameraNode values: {e}")
        
        # --- ZImageFunControlnet ---
        # Extract Z-Image specific ControlNet parameters
        elif class_type == 'ZImageFunControlnet':
            try:
                if 'strength' in inputs:
                    result['zimage_controlnet_strength'] = float(inputs['strength'])
                if 'model_patch' in inputs:
                    patch_ref = inputs['model_patch']
                    if isinstance(patch_ref, list) and len(patch_ref) > 0:
                        result['uses_zimage_controlnet_patch'] = True
                result['uses_zimage_controlnet'] = True
                LOGGER.debug(f"[PHG] Parsed ZImageFunControlnet: strength={result.get('zimage_controlnet_strength')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing ZImageFunControlnet values: {e}")
        
        # --- Epsilon Scaling ---
        # Extract epsilon scaling parameters
        elif class_type == 'Epsilon Scaling':
            try:
                if 'scaling_factor' in inputs:
                    result['epsilon_scaling_factor'] = float(inputs['scaling_factor'])
                LOGGER.debug(f"[PHG] Parsed Epsilon Scaling: factor={result.get('epsilon_scaling_factor')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing Epsilon Scaling values: {e}")
        
        # --- SmartDeNoiseFX / FastLaplacianSharpen / FastFilmGrain / FastUnsharpSharpen ---
        # Extract post-processing effect parameters
        elif class_type in ['SmartDeNoiseFX', 'FastLaplacianSharpen', 'FastFilmGrain', 'FastUnsharpSharpen']:
            try:
                if class_type == 'SmartDeNoiseFX':
                    if 'sigma' in inputs:
                        result['post_sigma'] = float(inputs['sigma'])
                    if 'threshold' in inputs:
                        result['post_threshold'] = float(inputs['threshold'])
                elif class_type == 'FastLaplacianSharpen':
                    if 'strength' in inputs:
                        result['post_sharpen_strength'] = float(inputs['strength'])
                elif class_type == 'FastFilmGrain':
                    if 'grain_intensity' in inputs:
                        result['post_grain_intensity'] = float(inputs['grain_intensity'])
                    if 'saturation_mix' in inputs:
                        result['post_saturation_mix'] = float(inputs['saturation_mix'])
                elif class_type == 'FastUnsharpSharpen':
                    if 'strength' in inputs:
                        result['post_unsharp_strength'] = float(inputs['strength'])
                result['uses_post_processing'] = True
                LOGGER.debug(f"[PHG] Parsed {class_type} post-processing effect")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- ProPostApplyLUT ---
        # Extract LUT application parameters
        elif class_type == 'ProPostApplyLUT':
            try:
                if 'lut_name' in inputs:
                    result['lut_name'] = str(inputs['lut_name'])
                if 'strength' in inputs:
                    result['lut_strength'] = float(inputs['strength'])
                result['uses_lut'] = True
                LOGGER.debug(f"[PHG] Parsed ProPostApplyLUT: {result.get('lut_name')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing ProPostApplyLUT values: {e}")
        
        # --- CLIPSetLastLayer ---
        # Extract CLIP skip/last layer setting
        elif class_type == 'CLIPSetLastLayer':
            try:
                if 'stop_at_clip_layer' in inputs:
                    result['clip_skip'] = int(inputs['stop_at_clip_layer'])
                    # Convert negative index to positive skip value if needed
                    if result['clip_skip'] < 0:
                        result['clip_skip'] = abs(result['clip_skip'])
                LOGGER.debug(f"[PHG] Parsed CLIPSetLastLayer: clip_skip={result.get('clip_skip')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing CLIPSetLastLayer values: {e}")
        
        # --- PathchSageAttentionKJ ---
        # Extract attention optimization settings
        elif class_type == 'PathchSageAttentionKJ':
            try:
                if 'sage_attention' in inputs:
                    result['attention_type'] = str(inputs['sage_attention'])
                if 'allow_compile' in inputs:
                    result['attention_compile'] = inputs['allow_compile']
                result['uses_custom_attention'] = True
                LOGGER.debug(f"[PHG] Parsed PathchSageAttentionKJ: type={result.get('attention_type')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing PathchSageAttentionKJ values: {e}")
        
        # --- FluxResolutionNode / CR Aspect Ratio Social Media ---
        # Extract resolution/aspect ratio from dynamic nodes
        elif class_type in ['FluxResolutionNode', 'CR Aspect Ratio Social Media']:
            try:
                if 'megapixel' in inputs:
                    result['target_megapixels'] = str(inputs['megapixel'])
                if 'aspect_ratio' in inputs:
                    result['target_aspect_ratio'] = str(inputs['aspect_ratio'])
                if 'resolution' in inputs:
                    result['target_resolution'] = str(inputs['resolution'])
                LOGGER.debug(f"[PHG] Parsed {class_type}: aspect={result.get('target_aspect_ratio')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- LatentBlend ---
        # Extract latent blending parameters
        elif class_type == 'LatentBlend':
            try:
                if 'blend_factor' in inputs:
                    result['latent_blend_factor'] = float(inputs['blend_factor'])
                result['uses_latent_blend'] = True
                LOGGER.debug(f"[PHG] Parsed LatentBlend: factor={result.get('latent_blend_factor')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing LatentBlend values: {e}")
        
        # --- MoirePatternGenerator ---
        # Mark that moire pattern was used (complex effect)
        elif class_type == 'MoirePatternGenerator':
            try:
                if 'pattern_type' in inputs:
                    result['moire_pattern_type'] = str(inputs['pattern_type'])
                if 'grid_size' in inputs:
                    result['moire_grid_size'] = float(inputs['grid_size'])
                result['uses_moires'] = True
                LOGGER.debug(f"[PHG] Detected MoirePatternGenerator: type={result.get('moire_pattern_type')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing MoirePatternGenerator values: {e}")
        
        # --- RBG_Smart_Seed_Variance ---
        # Extract advanced seed variance parameters
        elif class_type == 'RBG_Smart_Seed_Variance':
            try:
                if 'fine_tune_variance' in inputs:
                    result['rbg_variance_fine_tune'] = int(inputs['fine_tune_variance'])
                if 'shift_strength' in inputs:
                    result['rbg_variance_shift_strength'] = int(inputs['shift_strength'])
                if 'variance_schedule' in inputs:
                    result['rbg_variance_schedule'] = str(inputs['variance_schedule'])
                if 'cutoff_step' in inputs:
                    result['rbg_cutoff_step'] = int(inputs['cutoff_step'])
                result['uses_rbg_variance'] = True
                LOGGER.debug(f"[PHG] Parsed RBG_Smart_Seed_Variance: fine_tune={result.get('rbg_variance_fine_tune')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing RBG_Smart_Seed_Variance values: {e}")
        
        # --- ImageSave / SaveImageWithMetaData / Image Saver Simple ---
        # Extract save settings (for reference)
        elif class_type in ['Image Save', 'SaveImageWithMetaData', 'Image Saver Simple', 'Image Saver']:
            try:
                if 'filename_prefix' in inputs:
                    result['save_filename_prefix'] = str(inputs['filename_prefix'])
                if 'output_format' in inputs:
                    result['save_format'] = str(inputs['output_format'])
                if 'quality' in inputs:
                    result['save_quality'] = str(inputs['quality'])
                if 'dpi' in inputs:
                    result['save_dpi'] = int(inputs['dpi'])
                LOGGER.debug(f"[PHG] Parsed save settings from {class_type}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing save settings: {e}")
        
        # --- EmptyLatentImage / EmptySD3LatentImage / EmptyFlux2LatentImage ---
        # Extract resolution from empty latent image nodes
        elif class_type in ['EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyFlux2LatentImage'] and not found_resolution:
            try:
                width = None
                height = None
                if len(widgets_values) >= 2:
                    width = int(float(widgets_values[0]))
                    height = int(float(widgets_values[1]))
                elif 'width' in inputs and 'height' in inputs:
                    width = int(float(inputs['width']))
                    height = int(float(inputs['height']))
                
                if width and height:
                    result['width'] = width
                    result['height'] = height
                    found_resolution = True
                    LOGGER.debug(f"[PHG] Parsed {class_type}: {width}x{height}")
            except (ValueError, TypeError, IndexError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- ModelSamplingFlux / ModelSamplingAuraFlow / ModelSamplingSD3 / ModelSamplingZImage ---
        # Extract sampling parameters from model sampling nodes
        elif class_type in ['ModelSamplingFlux', 'ModelSamplingAuraFlow', 'ModelSamplingSD3', 'ModelSamplingZImage']:
            try:
                if 'max_shift' in inputs:
                    result['flux_max_shift'] = float(inputs['max_shift'])
                if 'base_shift' in inputs:
                    result['flux_base_shift'] = float(inputs['base_shift'])
                if 'shift' in inputs:
                    result['aura_shift'] = float(inputs['shift'])
                if 'multiplier' in inputs:
                    result['sampling_multiplier'] = float(inputs['multiplier'])
                if 'width' in inputs and not found_resolution:
                    result['width'] = int(float(inputs['width']))
                if 'height' in inputs and not found_resolution:
                    result['height'] = int(float(inputs['height']))
                # Mark resolution as found if we got both width and height
                if 'width' in result and 'height' in result:
                    found_resolution = True
                LOGGER.debug(f"[PHG] Parsed {class_type}: shift={result.get('aura_shift')}, multiplier={result.get('sampling_multiplier')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- FluxGuidance ---
        # Extract Flux guidance scale
        elif class_type == 'FluxGuidance':
            try:
                if 'guidance' in inputs:
                    result['flux_guidance'] = float(inputs['guidance'])
                    LOGGER.debug(f"[PHG] Parsed FluxGuidance: {result['flux_guidance']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing FluxGuidance values: {e}")
        
        # --- CFGNorm ---
        # Extract CFG normalization strength
        elif class_type == 'CFGNorm':
            try:
                if 'strength' in inputs:
                    result['cfg_norm_strength'] = float(inputs['strength'])
                    LOGGER.debug(f"[PHG] Parsed CFGNorm strength: {result['cfg_norm_strength']}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing CFGNorm values: {e}")
        
        # --- TextEncodeQwenImageEditPlus ---
        # Extract Qwen image edit prompt and mode
        elif class_type == 'TextEncodeQwenImageEditPlus':
            try:
                if 'prompt' in inputs and inputs['prompt'] and 'qwen_prompt' not in result:
                    result['qwen_prompt'] = inputs['prompt']
                    LOGGER.debug(f"[PHG] Parsed Qwen prompt: {result['qwen_prompt'][:50]}...")
                if 'image1' in inputs or 'image2' in inputs or 'image3' in inputs:
                    result['qwen_edit_mode'] = True
                    LOGGER.debug("[PHG] Detected Qwen edit mode")
            except Exception as e:
                LOGGER.debug(f"[PHG] Error parsing TextEncodeQwenImageEditPlus values: {e}")
        
        # --- DWPreprocessor ---
        # Extract DWPose estimator parameters
        elif class_type == 'DWPreprocessor':
            try:
                if 'resolution' in inputs:
                    result['pose_resolution'] = int(inputs['resolution'])
                    LOGGER.debug(f"[PHG] Parsed DWPreprocessor resolution: {result['pose_resolution']}")
                if 'bbox_detector' in inputs:
                    result['pose_bbox_detector'] = inputs['bbox_detector']
                if 'pose_estimator' in inputs:
                    result['pose_estimator'] = inputs['pose_estimator']
                if 'detect_hand' in inputs:
                    result['pose_detect_hand'] = inputs['detect_hand']
                if 'detect_body' in inputs:
                    result['pose_detect_body'] = inputs['detect_body']
                if 'detect_face' in inputs:
                    result['pose_detect_face'] = inputs['detect_face']
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing DWPreprocessor values: {e}")
        
        # --- BiRefNetRMBG ---
        # Extract background removal model
        elif class_type == 'BiRefNetRMBG':
            try:
                if 'model' in inputs:
                    result['bg_removal_model'] = inputs['model']
                    LOGGER.debug(f"[PHG] Parsed BiRefNetRMBG model: {result['bg_removal_model']}")
                if 'mask_blur' in inputs:
                    result['bg_mask_blur'] = int(inputs['mask_blur'])
                if 'invert_output' in inputs:
                    result['bg_invert_mask'] = inputs['invert_output']
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing BiRefNetRMBG values: {e}")
        
        # --- ImageCropByMaskAndResize ---
        # Extract crop and resize parameters
        elif class_type == 'ImageCropByMaskAndResize':
            try:
                if 'base_resolution' in inputs:
                    result['crop_base_resolution'] = int(inputs['base_resolution'])
                if 'padding' in inputs:
                    result['crop_padding'] = int(inputs['padding'])
                if 'min_crop_resolution' in inputs:
                    result['crop_min_resolution'] = int(inputs['min_crop_resolution'])
                if 'max_crop_resolution' in inputs:
                    result['crop_max_resolution'] = int(inputs['max_crop_resolution'])
                LOGGER.debug(f"[PHG] Parsed ImageCropByMaskAndResize: base={result.get('crop_base_resolution')}, padding={result.get('crop_padding')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing ImageCropByMaskAndResize values: {e}")
        
        # --- VAEEncodeTiled / VAEDecodeTiled ---
        # Extract tiled VAE parameters
        elif class_type in ['VAEEncodeTiled', 'VAEDecodeTiled']:
            try:
                if 'tile_size' in inputs:
                    result['tile_size'] = int(inputs['tile_size'])
                if 'overlap' in inputs:
                    result['tile_overlap'] = int(inputs['overlap'])
                if 'temporal_size' in inputs:
                    result['temporal_size'] = int(inputs['temporal_size'])
                if 'temporal_overlap' in inputs:
                    result['temporal_overlap'] = int(inputs['temporal_overlap'])
                LOGGER.debug(f"[PHG] Parsed {class_type}: tile_size={result.get('tile_size')}, overlap={result.get('tile_overlap')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- InpaintModelConditioning ---
        # Mark that inpainting was used
        elif class_type == 'InpaintModelConditioning':
            try:
                result['is_inpaint'] = True
                LOGGER.debug("[PHG] Detected inpainting workflow")
            except Exception as e:
                LOGGER.debug(f"[PHG] Error marking InpaintModelConditioning: {e}")
        
        # --- ImageScaleToTotalPixels / ImageScaleBy / ImageResizeKJv2 ---
        # Extract image scaling parameters
        elif class_type in ['ImageScaleToTotalPixels', 'ImageScaleBy', 'ImageResizeKJv2']:
            try:
                if 'width' in inputs and 'height' in inputs and not found_resolution:
                    result['width'] = int(float(inputs['width']))
                    result['height'] = int(float(inputs['height']))
                    found_resolution = True
                elif 'scale_by' in inputs:
                    result['scale_factor'] = float(inputs['scale_by'])
                if 'megapixels' in inputs:
                    result['target_megapixels'] = float(inputs['megapixels'])
                if 'upscale_method' in inputs:
                    result['upscale_method'] = inputs['upscale_method']
                LOGGER.debug(f"[PHG] Parsed {class_type}: scale={result.get('scale_factor')}, mp={result.get('target_megapixels')}")
            except (ValueError, TypeError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
        
        # --- CheckpointLoaderSimple ---
        # --- CheckpointLoaderSimple ---
        elif class_type == 'CheckpointLoaderSimple' and not found_model:
            try:
                model_name = None
                if len(widgets_values) >= 1:
                    model_path = str(widgets_values[0])
                    model_name = model_path.split('/')[-1].split('\\\\')[-1]
                elif 'ckpt_name' in inputs:
                    model_path = str(inputs['ckpt_name'])
                    model_name = model_path.split('/')[-1].split('\\\\')[-1]
                
                if model_name:
                    result['model_name'] = model_name
                    found_model = True
                    LOGGER.debug(f"[PHG] Parsed {class_type}: {model_name}")
            except (ValueError, TypeError, IndexError) as e:
                LOGGER.debug(f"[PHG] Error parsing {class_type} values: {e}")
    
    LOGGER.debug(f"[PHG] Final extracted metadata: {result}")
    return result


def _parse_sd_parameters(params_text: str) -> Dict[str, Any]:
    """
    Parse parameters text from Stable Diffusion WebUI format.
    
    Example format:
    [parameters]:
    instagram photo, closeup face photo of 23 y.o in black sweater, pale skin, (smile:0.4), hard shadows
    Negative prompt: instagram photo, closeup face photo of 23 y.o in black sweater, pale skin, (smile:0.4), hard shadows
    Steps: 6, Sampler: DPM++ SDE, Schedule type: Karras, CFG scale: 1.5, Seed: 3197516009, Size: 512x768, Model hash: f47e942ad4, Model: realisticVisionV60B1_v51HyperVAE_418901, Denoising strength: 0.35, Hires upscale: 2, Hires steps: 2, Hires upscaler: SwinIR 4x, Downcast alphas_cumprod: True, Version: v1.10.1
    """
    if not params_text:
        return {}
    
    result = {}
    lines = params_text.strip().split('\n')
    
    # Remove [parameters] header if present
    if lines and lines[0].strip().lower() == '[parameters]:':
        lines = lines[1:]
    
    if len(lines) >= 1:
        # Find the last line which contains the parameters
        params_line = lines[-1]
        
        # Extract prompt and negative prompt
        negative_idx = params_text.find('Negative prompt:')
        if negative_idx != -1:
            # Everything before "Negative prompt:" is the positive prompt
            result['prompt'] = params_text[:negative_idx].strip()
            # Remove [parameters]: header from prompt if present
            if result['prompt'].startswith('[parameters]:'):
                result['prompt'] = result['prompt'][len('[parameters]:'):].strip()
            
            # Extract negative prompt and remaining parameters
            negative_end = params_text.find('\n', negative_idx)
            if negative_end != -1:
                result['negative_prompt'] = params_text[negative_idx + len('Negative prompt:'):negative_end].strip()
                # Remaining lines after negative prompt contain parameters
                remaining_text = params_text[negative_end:].strip()
                remaining_lines = remaining_text.split('\n')
                if len(remaining_lines) > 1:
                    params_line = remaining_lines[-1]
            else:
                neg_params_split = params_text[negative_idx + len('Negative prompt:'):].strip().rsplit('\n', 1)
                if len(neg_params_split) == 2:
                    result['negative_prompt'] = neg_params_split[0].strip()
                    params_line = neg_params_split[1]
                else:
                    result['negative_prompt'] = neg_params_split[0].strip()
        else:
            # No negative prompt found
            if len(lines) > 1:
                result['prompt'] = '\n'.join(lines[:-1]).strip()
                # Remove [parameters]: header from prompt if present
                if result['prompt'].startswith('[parameters]:'):
                    result['prompt'] = result['prompt'][len('[parameters]:'):].strip()
            else:
                if ':' in params_line and any(k in params_line for k in ['Steps', 'Sampler', 'CFG', 'Seed']):
                    result['prompt'] = ''
                else:
                    result['prompt'] = params_line
        
        # Parse parameter pairs from the last line
        param_pairs = params_line.split(', ')
        for pair in param_pairs:
            if ':' in pair:
                key, value = pair.split(':', 1)
                key = key.strip()
                value = value.strip()
                
                if key == 'Steps':
                    result['steps'] = int(value) if value.isdigit() else value
                elif key in ['CFG scale', 'CFG']:
                    result['cfg'] = float(value) if value.replace('.', '').isdigit() else value
                elif key == 'Sampler':
                    result['sampler_name'] = value
                elif key in ['Schedule type', 'Scheduler']:
                    result['scheduler'] = value
                elif key == 'Seed':
                    result['seed'] = int(value) if value.isdigit() else value
                elif key == 'Size':
                    if 'x' in value.lower():
                        dimensions = value.lower().split('x')
                        if len(dimensions) == 2:
                            result['width'] = int(dimensions[0])
                            result['height'] = int(dimensions[1])
                elif key in ['Model hash', 'Model hash:']:
                    result['model_hash'] = value
                elif key == 'Model':
                    result['model_name'] = value
                elif key in ['Denoising strength', 'Denoise']:
                    result['denoise'] = float(value) if value.replace('.', '').isdigit() else value
                elif key == 'Hires upscale':
                    result['hires_upscale'] = float(value) if value.replace('.', '').isdigit() else value
                elif key == 'Hires steps':
                    result['hires_steps'] = int(value) if value.isdigit() else value
                elif key == 'Hires upscaler':
                    result['hires_upscaler'] = value
                elif key == 'Downcast alphas_cumprod':
                    result['downcast_alphas_cumprod'] = value.lower() == 'true'
                elif key == 'Version':
                    result['sd_webui_version'] = value
                elif key == 'Clip skip':
                    result['clip_skip'] = int(value) if value.isdigit() else value
                elif key == 'ENSD':
                    result['ensd'] = int(value) if value.isdigit() else value
                else:
                    # Store other parameters with normalized key
                    normalized_key = key.lower().replace(' ', '_')
                    result[normalized_key] = value
    
    return result


def extract_metadata_from_archive_images(archive_dir: Path) -> Dict[str, Dict[str, Any]]:
    """
    Extract metadata from all PNG images in the archive directory.
    """
    if not archive_dir.exists():
        LOGGER.warning(f"Archive directory does not exist: {archive_dir}")
        return {}
    
    metadata_map = {}
    
    for png_file in archive_dir.rglob("*.png"):
        try:
            relative_path = png_file.relative_to(archive_dir)
            if relative_path.parent == Path('.'):
                key = png_file.name
            else:
                key = str(relative_path)
            
            metadata = _extract_metadata_from_png(png_file)
            if metadata:
                # Only add if we have useful parameters (not just full workflow schema)
                useful = {k: v for k, v in metadata.items() if k != '_comfyui_full_workflow'}
                if useful:
                    metadata_map[key] = metadata
                    LOGGER.debug(f"Extracted metadata from {key}: {list(useful.keys())}")
                else:
                    LOGGER.debug(f"No useful metadata found in {key}")
            else:
                LOGGER.debug(f"No metadata found in {key}")
                
        except Exception as e:
            LOGGER.error(f"Error processing {png_file}: {e}")
    
    return metadata_map


def normalize_extracted_metadata(raw_metadata: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize extracted metadata to match our standard format.
    """
    normalized = {}
    
    key_mapping = {
        'steps': 'steps',
        'cfg': 'cfg',
        'cfg_scale': 'cfg',
        'sampler_name': 'sampler_name',
        'sampler': 'sampler_name',
        'scheduler': 'scheduler',
        'seed': 'seed',
        'width': 'width',
        'height': 'height',
        'size': 'dimensions',
        'model_name': 'model_name',
        'model': 'model_name',
        'model_hash': 'model_hash',
        'denoise': 'denoise',
        'prompt': 'prompt',
        'negative_prompt': 'negative_prompt',
        'clip_name': 'clip_name',
        'vae_name': 'vae_name',
        # Flux-specific parameters
        'flux_guidance': 'flux_guidance',
        'flux_max_shift': 'flux_max_shift',
        'flux_base_shift': 'flux_base_shift',
        # AuraFlow/ZImage parameters
        'aura_shift': 'aura_shift',
        'sampling_multiplier': 'sampling_multiplier',
        'flow_shift': 'flow_shift',
        'flow_base_shift': 'flow_base_shift',
        'flow_max_shift': 'flow_max_shift',
        'time_shift_type': 'time_shift_type',
        # CFG Normalization
        'cfg_norm_strength': 'cfg_norm_strength',
        # ETA and sampler options
        'eta': 'eta',
        's_noise': 's_noise',
        'bongmath': 'bongmath',
        'sampler_mode': 'sampler_mode',
        # Detail Daemon parameters
        'detail_amount': 'detail_amount',
        'detail_bias': 'detail_bias',
        'detail_exponent': 'detail_exponent',
        # Beta sampling parameters
        'beta_alpha': 'beta_alpha',
        'beta_beta': 'beta_beta',
        # AYS model type
        'ays_model_type': 'ays_model_type',
        # LoRA, ControlNet, Upscale models (arrays)
        'loras': 'loras',
        'controlnets': 'controlnets',
        'upscale_models': 'upscale_models',
        # FaceDetailer parameters
        'face_detailer_steps': 'face_detailer_steps',
        'face_detailer_denoise': 'face_detailer_denoise',
        'face_detailer_cfg': 'face_detailer_cfg',
        'face_detailer_sampler': 'face_detailer_sampler',
        # Ultimate SD Upscale parameters
        'usd_upscale_by': 'usd_upscale_by',
        'usd_steps': 'usd_steps',
        'usd_cfg': 'usd_cfg',
        'usd_sampler': 'usd_sampler',
        'usd_scheduler': 'usd_scheduler',
        'usd_denoise': 'usd_denoise',
        'usd_mode': 'usd_mode',
        # SeedVR2 parameters
        'seedvr2_resolution': 'seedvr2_resolution',
        'seedvr2_noise_scale': 'seedvr2_noise_scale',
        'seedvr2_color_correction': 'seedvr2_color_correction',
        'seedvr2_dit_model': 'seedvr2_dit_model',
        'seedvr2_vae_model': 'seedvr2_vae_model',
        # Patch/Noise injection parameters
        'patch_block_number': 'patch_block_number',
        'patch_downscale_factor': 'patch_downscale_factor',
        'noise_injection_strength': 'noise_injection_strength',
        # Variance enhancement
        'variance_randomize_percent': 'variance_randomize_percent',
        'variance_strength': 'variance_strength',
        'variance_noise_insert': 'variance_noise_insert',
        'rbg_variance_fine_tune': 'rbg_variance_fine_tune',
        'rbg_variance_shift_strength': 'rbg_variance_shift_strength',
        # Diffusion settings
        'diffusion_strength': 'diffusion_strength',
        'uses_differential_diffusion': 'uses_differential_diffusion',
        # Camera control
        'camera_horizontal_angle': 'camera_horizontal_angle',
        'camera_vertical_angle': 'camera_vertical_angle',
        'camera_zoom': 'camera_zoom',
        # Z-Image ControlNet
        'zimage_controlnet_strength': 'zimage_controlnet_strength',
        # Epsilon scaling
        'epsilon_scaling_factor': 'epsilon_scaling_factor',
        # Post-processing
        'post_sigma': 'post_sigma',
        'post_threshold': 'post_threshold',
        'post_sharpen_strength': 'post_sharpen_strength',
        'post_grain_intensity': 'post_grain_intensity',
        'post_saturation_mix': 'post_saturation_mix',
        'post_unsharp_strength': 'post_unsharp_strength',
        'lut_name': 'lut_name',
        'lut_strength': 'lut_strength',
        # CLIP skip
        'clip_skip': 'clip_skip',
        # Attention
        'attention_type': 'attention_type',
        'attention_compile': 'attention_compile',
        # Resolution/aspect ratio
        'target_megapixels': 'target_megapixels',
        'target_aspect_ratio': 'target_aspect_ratio',
        'target_resolution': 'target_resolution',
        # Latent blend
        'latent_blend_factor': 'latent_blend_factor',
        # Moire pattern
        'moire_pattern_type': 'moire_pattern_type',
        'moire_grid_size': 'moire_grid_size',
        # Save settings
        'save_filename_prefix': 'save_filename_prefix',
        'save_format': 'save_format',
        'save_quality': 'save_quality',
        'save_dpi': 'save_dpi',
    }
    
    for source_key, target_key in key_mapping.items():
        if source_key in raw_metadata:
            value = raw_metadata[source_key]
            if target_key in ['steps', 'seed', 'width', 'height']:
                try:
                    normalized[target_key] = int(value)
                except (ValueError, TypeError):
                    normalized[target_key] = value
            elif target_key == 'cfg':
                try:
                    normalized[target_key] = float(value)
                except (ValueError, TypeError):
                    normalized[target_key] = value
            else:
                normalized[target_key] = value
    
    if 'dimensions' in raw_metadata or 'size' in raw_metadata:
        size_val = raw_metadata.get('dimensions') or raw_metadata.get('size', '')
        if isinstance(size_val, str) and 'x' in size_val.lower():
            parts = size_val.lower().split('x')
            if len(parts) == 2:
                try:
                    normalized['width'] = int(parts[0])
                    normalized['height'] = int(parts[1])
                except ValueError:
                    pass
    
    return normalized