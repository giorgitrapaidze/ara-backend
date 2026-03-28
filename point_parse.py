from mcap.reader import make_reader
from mcap_ros2.reader import read_ros2_messages
import numpy as np
from scipy.spatial import KDTree
import os
import matplotlib.pyplot as plt
import json

def rip_trajectory(mcap_file_path, target_topic):
    print(f"parsing pairs from {mcap_file_path} ...")
    trajectory = []
    
    with open(mcap_file_path, "rb") as f:
        for msg in read_ros2_messages(f):
            if msg.channel.topic == target_topic:
                ros_data = msg.ros_msg
                try:
                    x = ros_data.x_m
                    y = ros_data.y_m
                    v = ros_data.v_mps
                    gas = ros_data.gas
                    brake = ros_data.brake
                    trajectory.append([x, y, v, gas, brake])
                except AttributeError:
                    msg_dict = vars(ros_data)
                    if 'x_m' in msg_dict:
                        trajectory.append([msg_dict['x_m'], msg_dict['y_m']])

    print(f"Parsing complete! Have {len(trajectory)} pairs\n")
    return np.array(trajectory)


def load_track_boundaries(json_path):
    print(f"Parsing track bounds from {json_path}...")
    try:
        with open(json_path, 'r') as f:
            bnd_data = json.load(f)
        
        # NOTE: Verify the exact JSON keys. Usually 'inner'/'outer' or similar.
        inner_bound = np.array(bnd_data.get('left_border', []))
        outer_bound = np.array(bnd_data.get('right_border', []))
        return inner_bound, outer_bound
    except FileNotFoundError:
        print("CRITICAL: Boundary JSON not found. Rendering without physical limits.")
        return np.array([]), np.array([])

inner_bnd, outer_bnd = load_track_boundaries("yas_marina_bnd.json")


coach_file = "hachathon_fast_laps.npy"
student_file = "hachathon_good_laps.npy"
wheel_to_wheel = "hachathon_wheel_to_wheel.npy"

if os.path.exists(coach_file):
    print(f"Have {coach_file}, load data from {coach_file}")
    coach_data = np.load(coach_file)
else:
    print(f"No {coach_file}")
    target_topic = "/constructor0/state_estimation"
    coach_data = rip_trajectory("hackathon_fast_laps.mcap", target_topic)
    np.save(coach_file, coach_data)
    print(f"Data are saved into {coach_file}!\n")

print("The shape of coach data: ", coach_data.shape) 

if os.path.exists(student_file):
    print(f"Have {student_file}, load data from {student_file}")
    student_data = np.load(student_file)
else:
    print(f"No {student_file}")
    target_topic = "/constructor0/state_estimation"
    student_data = rip_trajectory("hackathon_good_lap.mcap", target_topic)
    np.save(student_file, student_data)
    print(f"Data are saved into {student_file}!\n")

print("The shape of student data: ", student_data.shape) 

print("Creating KD-Tree index...")
coach_tree = KDTree(coach_data[:, :2]) 
print("KD-Tree finished.")


plt.figure(figsize=(12, 10))
plt.scatter(coach_data[:, 0], coach_data[:, 1], c='lime', s=1, label='Optimal Racing Line (Coach)')
plt.scatter(student_data[:, 0], student_data[:, 1], c='red', s=1, label='Actual Trajectory (Student)')
if inner_bnd.size > 0:
    plt.plot(inner_bnd[:, 0], inner_bnd[:, 1], 'k-', linewidth=1.2, alpha=0.7, label='Inner Bound')
if outer_bnd.size > 0:
    plt.plot(outer_bnd[:, 0], outer_bnd[:, 1], 'k-', linewidth=1.2, alpha=0.7, label='Outer Bound')

plt.axis('equal')

plt.title("Yas Marina Circuit - Agent Spatial Anchoring", fontsize=16, fontweight='bold')
plt.xlabel("Global X Coordinate (meters)")
plt.ylabel("Global Y Coordinate (meters)")
plt.legend(loc="upper right")
plt.grid(True, linestyle='--', alpha=0.5)

plt.show()

'''
early_braking_count = 0
for i in range(0, len(student_data), 10):
    stu_pos = student_data[i, :2]
    stu_v = student_data[i, 2]
    stu_brake = student_data[i, 4]
    
    distance, idx = coach_tree.query(stu_pos)
    coach_v = coach_data[idx, 2]
    coach_brake = coach_data[idx, 4]
    
    # If student brake in this position, but coach didn't
    if stu_brake > 0.1 and coach_brake < 0.05:
        print(f"[Warning] position: {stu_pos}: brake too much! Your speed {stu_v*3.6:.1f}km/h, Coach speed {coach_v*3.6:.1f}km/h")
        early_braking_count += 1

print(f"\nThere are {early_braking_count} times wrong brake!")
'''